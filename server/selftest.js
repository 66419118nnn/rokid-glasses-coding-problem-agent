/**
 * selftest.js — real compile-and-run verification for C++ answers.
 *
 * The answer is only trusted after the host itself compiled it and ran test cases:
 *
 *   answer → extract C++ → generate 3 cases → wsl g++ -std=c++17 → run cases
 *          → on failure re-prompt the model with the compiler stderr / the diff
 *          → at most `rounds` rewrites → final code + a status line
 *
 * Everything runs through WSL (Linux g++), never directly on Windows. The module
 * owns no DSH services; the caller injects an `llmText` helper for the hidden
 * case-generation and repair calls.
 *
 * @module rokid-bridge-dsh/selftest
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CASE_GENERATION_SYSTEM = '你是 C++ 判题助手。只输出一个 JSON 数组，不要解释、不要 Markdown 代码围栏、不要注释。'
const REPAIR_SYSTEM = '你是 C++17 编程助手。只输出修复后的完整程序源码：从 #include 开始，不要 Markdown 围栏，不要任何解释。'

/**
 * Build the verifier bound to one plugin context/config.
 * @param options.llmText - `({system, prompt, signal}) => Promise<string>` hidden model call.
 * @param options.log - plugin logger `(level, message) => void`.
 * @param options.config - resolved plugin config.
 * @returns a verifier instance.
 */
export function createSelfTest({ llmText, escalate, log, config }) {
    const workRoot = config.selftestWorkDir
    const escalateFn = typeof escalate === 'function' ? escalate : undefined
    let compiler
    let compilerProbe

    /** Probe WSL and g++ once; cache the answer for the process lifetime. */
    async function probeCompiler(force = false) {
        if (compiler !== undefined && !force) return compiler
        if (compilerProbe !== undefined) return compilerProbe
        compilerProbe = (async () => {
            try {
                const result = await runProcess(wslArgs('command -v g++ && g++ --version | head -1'), 10_000)
                const text = stripWslNoise(`${result.stdout}\n${result.stderr}`)
                compiler = result.code === 0 && /\/g\+\+|\bg\+\+ /u.test(text)
                    ? { available: true, detail: text.split('\n').slice(-1)[0] ?? '' }
                    : { available: false, detail: text || `exit ${result.code}` }
            } catch (error) {
                compiler = { available: false, detail: describeError(error) }
            }
            log('info', `[SELFTEST] compiler=${compiler.available ? 'ok' : 'missing'} (${compiler.detail})`)
            return compiler
        })()
        return compilerProbe
    }

    /**
     * Verify one answer.
     * @param request an object `{ answer, requestText, deviceId, requestId, signal, deadline }`.
     * @returns `{ status, code, answer, rounds, compileOk, casesTotal, casesPassed, detail, logLine }`.
     */
    async function verify(request) {
        const started = Date.now()
        const onProgress = typeof request.onProgress === 'function' ? request.onProgress : () => {}
        const notify = (phase, round) => {
            try {
                onProgress(phase, round)
            } catch {
                // progress frames must never break verification
            }
        }
        const probe = await probeCompiler()
        if (!probe.available) {
            return { status: 'skipped', answer: request.answer, rounds: 0, detail: 'compiler missing', logLine: '[SELFTEST] skipped (compiler missing)' }
        }
        const extracted = extractCode(request.answer)
        if (extracted === null) {
            return { status: 'no-code', answer: request.answer, rounds: 0, detail: 'no code in answer', logLine: '[SELFTEST] skipped (no code)' }
        }

        let code = extracted.code
        const debugBreak = request.debugBreak ?? config.selftestDebugBreak
        if (debugBreak === 'compile') {
            code = `#error DEBUG_SELFTEST_COMPILE_BREAK\n${code}`
            log('warn', '[SELFTEST] debug: 注入编译错误，用于验证回灌链路')
        }

        // Bounded retry policy: an unreachable case must never hang the request.
        const maxAttempts = Math.max(0, Number(config.selftestMaxAttempts) || 0) // 0 = unlimited
        const maxCaseFailures = Math.max(1, Number(config.selftestMaxCaseFailures) || 3)
        const repeatLimit = Math.max(1, Number(config.selftestRepeatLimit) || 2)
        const maxEscalations = Math.max(0, Number(config.selftestEscalations) || 0)
        const budgetMs = Math.max(0, Number(config.selftestBudgetSeconds) || 0) * 1000
        const deadline = budgetMs > 0 ? started + budgetMs : Number.POSITIVE_INFINITY
        const remaining = () => (Number.isFinite(deadline) ? deadline - Date.now() : Number.POSITIVE_INFINITY)

        let cases = await generateCases({ code, requestText: request.requestText, signal: request.signal, remaining })
        if (cases === null) {
            return { status: 'no-cases', answer: request.answer, rounds: 0, detail: 'case generation failed', logLine: '[SELFTEST] skipped (no cases)' }
        }
        const baselineCases = cases.map((item) => ({ ...item }))
        const caseFailures = new Map()
        const casePasses = new Map()

        const dir = join(workRoot, `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`)
        await mkdir(dir, { recursive: true })
        const wslDir = toWslPath(dir)
        let lastError = ''
        let lastActual = ''
        let lastSignature = ''
        let repeats = 0
        let repairMisses = 0
        let caseRegenerations = 0
        let attempts = 0
        let totalAttempts = 0
        let repairs = 0
        let escalations = 0
        let stopReason = ''
        let compileOk = false
        let casesPassed = 0
        let failedCaseIndex = -1

        try {
            for (;;) {
                if (request.signal?.aborted === true) {
                    return { status: 'aborted', code, answer: request.answer, rounds: repairs, detail: 'client gone', logLine: '[SELFTEST] aborted (client gone)' }
                }
                if (Number.isFinite(deadline) && remaining() <= 2_000) {
                    stopReason = 'timeout'
                    break
                }

                attempts += 1
                totalAttempts += 1
                await writeFile(join(dir, 'main.cpp'), code, 'utf8')
                if (attempts === 1) notify('compile', 1)
                const compiled = await compile(wslDir)
                let failure
                if (!compiled.ok) {
                    compileOk = false
                    failedCaseIndex = -1
                    failure = compiled.output
                    log('warn', `[SELFTEST] compile 失败（第 ${attempts} 次尝试）：${firstLine(compiled.output)}`)
                } else {
                    compileOk = true
                    cases = baselineCases.map((item) => ({ ...item }))
                    if (debugBreak === 'logic' && attempts === 1 && cases.length > 0) {
                        cases = [{ ...cases[0], expected: `${cases[0].expected}__DEBUG_MISMATCH__` }, ...cases.slice(1)]
                        log('warn', '[SELFTEST] debug: 污染第一组期望输出，用于验证用例回灌链路')
                    }
                    const run = await runCases(dir, wslDir, cases, remaining)
                    casesPassed = run.passed
                    if (run.failedIndex === -1) {
                        return finish('ok', code, repairs, true, run.passed, cases.length, '')
                    }
                    failedCaseIndex = run.failedIndex
                    lastActual = run.lastOutput
                    const item = cases[run.failedIndex]
                    failure = `用例 ${run.failedIndex + 1} 未通过\n输入：\n${item.input}\n期望输出：\n${item.expected}\n实际输出：\n${run.lastOutput}`
                    caseFailures.set(run.failedIndex, (caseFailures.get(run.failedIndex) ?? 0) + 1)
                    for (let index = 0; index < run.failedIndex; index += 1) {
                        casePasses.set(index, (casePasses.get(index) ?? 0) + 1)
                    }
                    log('warn', `[SELFTEST] 用例 ${run.failedIndex + 1}/${cases.length} 未通过（第 ${attempts} 次尝试）`)
                }

                lastError = failure
                const signature = `x:${failure.slice(0, 400)}:${code.length}`
                repeats = signature === lastSignature ? repeats + 1 : 1
                lastSignature = signature

                const hitCaseCap = failedCaseIndex >= 0 && (caseFailures.get(failedCaseIndex) ?? 0) >= maxCaseFailures
                const hitRepeat = repeats >= repeatLimit
                const hitAttempts = maxAttempts > 0 && attempts >= maxAttempts

                if (hitCaseCap || hitRepeat || hitAttempts) {
                    // A case that keeps failing while every other case passes is usually
                    // a bad generated expectation: debugging cannot make it pass.
                    const otherCasesStable = failedCaseIndex >= 0
                        && baselineCases.every((_, index) => index === failedCaseIndex
                            || (casePasses.get(index) ?? 0) >= Math.max(1, maxCaseFailures - 1))
                    const suspectNow = hitCaseCap && otherCasesStable
                    if (suspectNow && caseRegenerations < 1) {
                        // One failing case while everything else passes usually means the
                        // generated expectation is wrong. Regenerate once, then decide.
                        caseRegenerations += 1
                        const fresh = await generateCases({
                            code,
                            requestText: request.requestText,
                            signal: request.signal,
                            remaining,
                        })
                        if (fresh !== null && fresh.length > 0) {
                            baselineCases.splice(0, baselineCases.length, ...fresh.map((item) => ({ ...item })))
                            caseFailures.clear()
                            casePasses.clear()
                            repeats = 0
                            lastSignature = ''
                            attempts = 0
                            log('warn', '[SELFTEST] 只有一组用例反复失败，判定期望值可疑，重新生成用例后重试')
                            continue
                        }
                    }
                    if (suspectNow) {
                        log('warn', '[SELFTEST] 只有这一组用例反复失败而其它都通过，判定为用例期望值可疑，不再升级调试')
                    }
                    // Mechanical rewriting stopped helping: hand the problem to the
                    // agent session, which can actually compile and debug with tools.
                    if (!suspectNow && escalateFn !== undefined && escalations < maxEscalations && request.signal?.aborted !== true) {
                        escalations += 1
                        const why = hitCaseCap
                            ? `同一组用例连续 ${maxCaseFailures} 次未通过`
                            : hitRepeat ? '同一失败重复出现' : `机械重写 ${attempts} 次未过`
                        log('warn', `[SELFTEST] ${why}，转交 agent 深度调试（第 ${escalations}/${maxEscalations} 次）`)
                        const outcome = await escalateFn({
                            code,
                            problem: request.requestText,
                            error: failure,
                            cases: baselineCases,
                            failedCase: failedCaseIndex,
                            deviceId: request.deviceId,
                            requestId: request.requestId,
                            signal: request.signal,
                        }).catch(() => null)
                        const fixedCode = typeof outcome?.code === 'string' ? outcome.code.trim() : ''
                        if (fixedCode !== '') {
                            log('info', `[SELFTEST] agent 调试返回了新代码（${fixedCode.length} 字符），继续验证`)
                            code = fixedCode
                            attempts = 0
                            repairs = 0
                            caseFailures.clear()
                            casePasses.clear()
                            repeats = 0
                            lastSignature = ''
                            repairMisses = 0
                            continue
                        }
                        log('warn', '[SELFTEST] agent 调试没有产出可用代码')
                    }
                    stopReason = hitCaseCap ? 'case-failures' : hitRepeat ? 'repeat' : 'attempts'
                    break
                }

                notify('repair', repairs + 1)
                const fixed = await repair({
                    code,
                    error: failure,
                    requestText: request.requestText,
                    signal: request.signal,
                    remaining,
                    insist: repeats > 1,
                })
                repairs += 1
                if (fixed === null) {
                    repairMisses += 1
                    if (repairMisses >= 3) {
                        stopReason = 'repair-failed'
                        break
                    }
                    log('warn', `[SELFTEST] 第 ${repairs} 次修复没拿到可用代码，稍后重试`)
                    await delay(1_000)
                    continue
                }
                repairMisses = 0
                code = fixed
            }
            return finishFailure(stopReason, code, totalAttempts, repairs, baselineCases, failedCaseIndex, escalations)
        } finally {
            if (!config.selftestKeepWorkDir) {
                void rm(dir, { recursive: true, force: true }).catch(() => {})
            }
        }

        function finishFailure(reason, finalCode, usedAttempts, usedRepairs, allCases, failedIndex, usedEscalations = 0) {
            const ms = Date.now() - started
            const failures = failedIndex >= 0 ? (caseFailures.get(failedIndex) ?? 0) : 0
            const suspect = failedIndex >= 0
                && failures >= maxCaseFailures
                && allCases.every((_, index) => index === failedIndex || (casePasses.get(index) ?? 0) >= Math.max(1, maxCaseFailures - 1))
            const clip = (text, limit = 60) => {
                const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
                return value.length <= limit ? value : `${value.slice(0, limit)}…`
            }
            const caseNote = failedIndex >= 0
                ? `第 ${failedIndex + 1} 组用例期望 ${clip(allCases[failedIndex]?.expected)}，实际 ${clip(lastActual)}`
                : ''
            const compileNote = failedIndex < 0 ? `编译失败——${clip(firstLine(lastError), 80)}` : ''
            const detailText = caseNote !== '' ? `${caseNote}。` : `${compileNote}。`
            const statusLine = reason === 'timeout'
                ? `（主机验证超时（${Math.round(budgetMs / 1000)} 秒）：${detailText}下面是最后一版代码）`
                : reason === 'attempts'
                    ? `（主机验证已尝试 ${usedAttempts} 次仍未通过：${detailText}下面是最后一版代码）`
                    : `（主机验证未通过：${detailText}已尝试 ${usedAttempts} 次、重写 ${usedRepairs} 次后停止，下面是最后一版代码）`
            const summary = '[SELFTEST] status=failed'
                + ` reason=${reason || 'unknown'} compile=${compileOk ? 'ok' : 'fail'}`
                + ` attempts=${usedAttempts} repairs=${usedRepairs} cases=${casesPassed}/${allCases.length}`
                + (usedEscalations > 0 ? ` escalations=${usedEscalations}` : '')
                + (failedIndex >= 0 ? ` case=${failedIndex + 1} expected=${clip(allCases[failedIndex]?.expected, 40)} actual=${clip(lastActual, 40)}` : '')
                + (suspect ? ' suspect-case=1' : '')
                + ` ms=${ms}`
            const answer = composeAnswer(request.answer, extracted, finalCode, statusLine)
            log(suspect ? 'warn' : 'info', summary)
            return {
                status: 'failed',
                code: finalCode,
                answer,
                rounds: usedRepairs,
                compileOk,
                casesTotal: allCases.length,
                casesPassed,
                detail: { reason, failedIndex, suspect, lastError },
                logLine: summary,
            }
        }

        function finish(status, finalCode, usedRounds, compiled, passed, total, detail) {
            const ms = Date.now() - started
            const statusLine = status === 'ok'
                ? `已通过编译与 ${passed} 组用例`
                : status === 'fuse'
                    ? '（主机验证还没跑完，先发这一版）'
                    : status === 'capped'
                        ? '（主机验证到了设定上限，先发这一版）'
                        : '（主机这边暂时没法继续验证，先发这一版）'
            const answer = composeAnswer(request.answer, extracted, finalCode, statusLine)
            const summary = status === 'ok'
                ? `[SELFTEST] compile=ok cases=${passed}/${total} rounds=${usedRounds} ms=${ms}`
                : `[SELFTEST] status=${status} compile=${compiled ? 'ok' : 'fail'} cases=${passed}/${total} rounds=${usedRounds} ms=${ms}`
            return { status, code: finalCode, answer, rounds: usedRounds, compileOk: compiled, casesTotal: total, casesPassed: passed, detail, logLine: summary }
        }
    }

    // ── model-side helpers ───────────────────────────────────────────────────
    async function generateCases({ code, requestText, signal, remaining }) {
        if (remaining() <= 5_000) return null
        const prompt = [
            '题目/用户需求：',
            truncate(requestText, 1500),
            '',
            '参考解答：',
            truncate(code, 4000),
            '',
            '请给出 3 组测试用例，必须覆盖 1 组边界情况（空输入、最小规模或退化输入）和 1 组容易出错的常规用例。',
            '严格输出 JSON 数组，每项：{"input": "程序的标准输入，可为空字符串", "expected": "程序的标准输出，必须与参考解答实际输出完全一致"}。',
            'input 与 expected 里可以包含换行（用 \\n 表示）。不要输出任何解释。',
        ].join('\n')
        try {
            const text = await llmText({ system: CASE_GENERATION_SYSTEM, prompt, signal: combineSignals(signal, 60_000) })
            const cases = parseCases(text)
            if (cases.length === 0) {
                log('warn', `[SELFTEST] 用例生成解析失败：${truncate(text, 200)}`)
                return null
            }
            return cases.slice(0, 5)
        } catch (error) {
            log('warn', `[SELFTEST] 用例生成失败：${describeError(error)}`)
            return null
        }
    }

    async function repair({ code, error, requestText, signal, remaining, insist }) {
        if (remaining() <= 8_000) return null
        const prompt = [
            '题目/用户需求：',
            truncate(requestText, 1200),
            '',
            '当前代码：',
            code,
            '',
            '主机实测结果：',
            truncate(error, 2500),
            '',
            ...(insist === true
                ? ['上一版修复后主机上的结果没有变化。请从题意重新推导，换一种实现思路，不要重复上一版的代码。']
                : []),
            '请修复后只输出完整程序源码（从 #include 开始），不要输出解释。',
        ].join('\n')
        try {
            const text = await llmText({
                system: REPAIR_SYSTEM,
                prompt,
                signal: combineSignals(signal, 120_000),
            })
            const extracted = extractCode(text)
            if (extracted === null) {
                log('warn', '[SELFTEST] 修复回复里没有可识别的代码')
                return null
            }
            return extracted.code
        } catch (failure) {
            log('warn', `[SELFTEST] 修复调用失败：${describeError(failure)}`)
            return null
        }
    }

    // ── WSL plumbing ─────────────────────────────────────────────────────────
    function wslArgs(script) {
        const distro = String(config.selftestWslDistro || '').trim()
        return distro === ''
            ? ['-e', 'sh', '-lc', script]
            : ['-d', distro, '-e', 'sh', '-lc', script]
    }

    async function compile(wslDir) {
        const limit = Math.max(3, Math.round(config.selftestCompileTimeoutMs / 1000))
        const script = `cd '${shellQuote(wslDir)}' && timeout ${limit} g++ -std=c++17 -O2 -Wall -o main main.cpp 2>&1; echo "EXIT:$?"`
        const result = await runProcess(wslArgs(script), config.selftestCompileTimeoutMs + 5_000)
        const combined = stripWslNoise(`${result.stdout}\n${result.stderr}`)
        const exit = parseExit(combined)
        return { ok: exit === 0, output: stripExit(combined) }
    }

    async function runCases(dir, wslDir, cases, remaining) {
        const limit = Math.max(1, Math.round(config.selftestCaseTimeoutMs / 1000))
        let passed = 0
        let lastOutput = ''
        for (let index = 0; index < cases.length; index += 1) {
            if (remaining() <= 3_000) return { passed, failedIndex: index, lastOutput: 'budget exhausted' }
            const item = cases[index]
            await writeFile(join(dir, 'input.txt'), item.input ?? '', 'utf8')
            const script = `cd '${shellQuote(wslDir)}' && timeout ${limit} ./main < input.txt 2>&1; echo "EXIT:$?"`
            const result = await runProcess(wslArgs(script), config.selftestCaseTimeoutMs + 5_000)
            const stdout = stripWslNoise(result.stdout)
            const stderr = stripWslNoise(result.stderr)
            const exit = parseExit(stdout)
            lastOutput = stripExit(stdout)
            if (stderr !== '') lastOutput += `\n[stderr]\n${stderr}`
            const actual = normalize(lastOutput, exit)
            const expected = normalize(item.expected ?? '', 0)
            if (actual === expected) {
                passed += 1
                continue
            }
            return { passed, failedIndex: index, lastOutput }
        }
        return { passed, failedIndex: -1, lastOutput }
    }

    // wslDir -> the Windows directory that holds main.cpp/input.txt (kept for tooling)
    function workRootOf(wslDir) {
        if (wslDir.startsWith('/mnt/')) {
            const rest = wslDir.slice('/mnt/'.length)
            const slash = rest.indexOf('/')
            const drive = rest.slice(0, slash).toUpperCase()
            const tail = rest.slice(slash + 1)
            return `${drive}:/${tail}`
        }
        return wslDir
    }

    return { verify, probeCompiler, extractCode }
}

/** Extract the C++ source region from an answer. */
export function extractCode(answer) {
    if (typeof answer !== 'string' || answer.trim() === '') return null
    const fence = /```(?:cpp|c\+\+|c)?\s*\r?\n([\s\S]*?)```/u.exec(answer)
    if (fence !== null && /#include/u.test(fence[1]) && /\bmain\s*\(/u.test(fence[1])) {
        const start = answer.indexOf(fence[0])
        return {
            code: fence[1].trim(),
            before: answer.slice(0, start),
            after: answer.slice(start + fence[0].length),
            fenced: true,
        }
    }
    const startIndex = answer.search(/^\s*#include\b/mu)
    if (startIndex < 0) return null

    // End the code at the closing brace of main(), not at the first depth-zero
    // brace: a global struct/class body closes at depth zero long before main.
    const tail = answer.slice(startIndex)
    const mainMatch = /\bmain\s*\(/u.exec(tail)
    if (mainMatch !== null) {
        const braceIndex = answer.indexOf('{', startIndex + mainMatch.index)
        if (braceIndex >= 0) {
            let depth = 0
            let end = -1
            let inString = false
            let quote = ''
            for (let index = braceIndex; index < answer.length; index += 1) {
                const character = answer[index]
                if (inString) {
                    if (character === '\\') index += 1
                    else if (character === quote) inString = false
                    continue
                }
                if (character === '"' || character === "'") {
                    inString = true
                    quote = character
                    continue
                }
                if (character === '{') depth += 1
                else if (character === '}') {
                    depth -= 1
                    if (depth === 0) {
                        end = index
                        break
                    }
                }
            }
            if (end > 0) {
                const code = answer.slice(startIndex, end + 1).trim()
                return {
                    code,
                    before: answer.slice(0, startIndex),
                    after: answer.slice(end + 1),
                    fenced: false,
                }
            }
        }
    }

    // No main(): treat only a brace-balanced tail as code, otherwise give up.
    const lines = answer.slice(startIndex).split(/\r?\n/u)
    let depth = 0
    let endLine = lines.length - 1
    for (let index = 0; index < lines.length; index += 1) {
        for (const character of lines[index]) {
            if (character === '{') depth += 1
            else if (character === '}') depth -= 1
        }
        if (index > 0 && depth <= 0 && /^\s*\}/u.test(lines[index])) {
            endLine = index
            break
        }
    }
    const code = lines.slice(0, endLine + 1).join('\n').trim()
    if (!/#include/u.test(code) || !/\bmain\s*\(/u.test(code)) return null
    return {
        code,
        before: answer.slice(0, startIndex),
        after: lines.slice(endLine + 1).join('\n'),
        fenced: false,
    }
}

/** Rebuild the answer around the verified code and append the status sentence. */
export function composeAnswer(original, extracted, finalCode, statusLine) {
    let body
    if (extracted !== null && finalCode !== extracted.code) {
        const parts = [extracted.before.trimEnd(), finalCode.trim(), extracted.after.trimStart()]
            .filter((part) => part !== '')
        body = parts.join(extracted.fenced ? '\n\n' : '\n')
    } else {
        body = String(original)
    }
    return `${body.trimEnd()}\n\n${statusLine}`
}

function parseCases(text) {
    if (typeof text !== 'string') return []
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    let parsed
    try {
        parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []
    const cases = []
    for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue
        let input = item.input ?? item.stdin ?? item.in
        let expected = item.expected ?? item.stdout ?? item.out ?? item.output
        if (input === undefined || expected === undefined) continue
        if (typeof input !== 'string') input = String(input)
        if (typeof expected !== 'string') expected = String(expected)
        cases.push({ input, expected })
    }
    return cases
}

function normalize(text, exitCode) {
    const cleaned = String(text ?? '').replace(/\r\n/gu, '\n').replace(/[ \t]+$/gmu, '').trimEnd()
    return exitCode === 0 ? cleaned : `${cleaned}\n<exit:${exitCode}>`
}

function parseExit(output) {
    const match = /EXIT:(-?\d+)\s*$/u.exec(output)
    return match === null ? -1 : Number(match[1])
}

/** wsl.exe prints its own diagnostics as UTF-16LE while the command output is UTF-8. */
function decodeWsl(buffer) {
    if (buffer === undefined || buffer === null || buffer.length === 0) return ''
    const limit = Math.min(buffer.length, 400)
    let zeroOdd = 0
    let pairs = 0
    for (let index = 1; index < limit; index += 2) {
        pairs += 1
        if (buffer[index] === 0) zeroOdd += 1
    }
    if (pairs > 4 && zeroOdd / pairs > 0.6) return buffer.toString('utf16le')
    return buffer.toString('utf8')
}

/** Drop wsl.exe's own "localhost proxy / NAT" advisory lines. */
function stripWslNoise(text) {
    return String(text ?? '')
        .replace(/\u0000/gu, '')
        .split(/\r?\n/u)
        .filter((line) => !/^\s*wsl[:：]/iu.test(line))
        .join('\n')
        .trim()
}

function stripExit(output) {
    return String(output ?? '').replace(/\n?EXIT:-?\d+\s*$/u, '').trim()
}

function runProcess(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('wsl.exe', args, { windowsHide: true })
        const chunks = []
        const errors = []
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try {
                child.kill('SIGKILL')
            } catch {
                // ignore
            }
            reject(new Error(`wsl command timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
        child.stdout.on('data', (chunk) => chunks.push(chunk))
        child.stderr.on('data', (chunk) => errors.push(chunk))
        child.on('error', (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({
                code: code ?? -1,
                stdout: decodeWsl(Buffer.concat(chunks)),
                stderr: decodeWsl(Buffer.concat(errors)),
            })
        })
    })
}

function toWslPath(winPath) {
    const normalized = String(winPath).replace(/\\/gu, '/')
    const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized)
    if (match !== null) return `/mnt/${match[1].toLowerCase()}/${match[2]}`
    return normalized
}

function shellQuote(value) {
    return String(value).replace(/'/gu, "'\\''")
}

function truncate(text, limit) {
    const value = String(text ?? '')
    return value.length <= limit ? value : `${value.slice(0, limit)}\n…（已截断）`
}

function firstLine(text) {
    return String(text ?? '').split('\n').find((line) => line.trim() !== '') ?? ''
}

function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
    })
}

/** Combine a caller signal with a per-call timeout so one stuck call cannot hang the loop. */
function combineSignals(signal, timeoutMs) {
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    if (signal === undefined || signal === null) return timeout
    if (timeout === undefined) return signal
    return AbortSignal.any([signal, timeout])
}

function describeError(error) {
    if (error === null || error === undefined) return 'unknown error'
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
}

/** Append one line to a log file in UTF-8 with a local timestamp; never throws. */
export async function appendSelfTestLog(path, line) {
    if (typeof path !== 'string' || path.trim() === '') return
    try {
        await mkdir(dirname(path), { recursive: true })
        const now = new Date()
        const pad = (value) => String(value).padStart(2, '0')
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
            + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
        await appendFile(path, `${stamp} ${line}\n`, 'utf8')
    } catch {
        // logging must never break a request
    }
}