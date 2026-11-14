/**
 * rokid-bridge-dsh — a Lingzhu (灵珠) custom-agent endpoint backed by DSH Agent sessions.
 *
 * Replaces the standalone Python `rokid-bridge` service with a Host plugin:
 *
 *   POST /chat     灵珠自定义智能体主通道, named-event SSE, answered by a DSH agent session
 *   POST /ask      简化版, {"text","image"} -> {"answer": "..."}
 *   POST /ask-raw  原始图片字节（Content-Type 定格式，?q= 问题）-> {"answer": "..."}
 *   GET  /health   {"status":"ok","service":"rokid-bridge"}
 *
 * The wire protocol is byte-compatible with the Python bridge:
 *
 *   event:message
 *   data:{"role":"agent","type":"answer","answer_stream":"片段","message_id":"…","agent_id":"…","is_finish":false}
 *   event:message
 *   data:{…,"answer_stream":"","is_finish":true}
 *   event:done
 *   data:[DONE]
 *
 * One agent session per device stays warm and serves every following request of that
 * device (conversation history, provider prefix cache, tools). Its session log carries
 * the deployment sandbox mode plus approval `never`, so nothing can block on a human
 * approval prompt. Sessions are recycled after `idleMinutes`.
 *
 * @module rokid-bridge-dsh
 */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createSelfTest, appendSelfTestLog, extractCode } from './selftest.js'

export const name = 'rokid-bridge-dsh'
export const inject = ['agents', 'agentDefaultModel', 'attachments', 'llm']

const VERSION = '0.10.5'

/** In-code defaults; the Config schema (when resolvable) mirrors them for the UI. */
const DEFAULTS = {
    host: '127.0.0.1',
    port: 8091,
    accessKey: '',
    legacyConfigPath: '',
    logPath: join(homedir(), 'rokid-bridge', 'bridge-dsh.log'),
    systemPrompt: '',
    workspace: '',
    sandboxMode: 'danger-full-access',
    agentPreset: '',
    reasoningEffort: '',
    idleMinutes: 30,
    maxDevices: 8,
    maxConcurrent: 4,
    turnTimeoutSeconds: 90,
    heartbeatSeconds: 9,
    selftestEnabled: true,
    takeOverLegacyPort: true,
    imageTriageEnabled: true,
    imageTriageTimeoutSeconds: 20,
    imageAckText: '（已收到照片，检查题目）',
    takePhotoEnabled: false,
    takePhotoCooldownSeconds: 60,
    imageMaxCaptures: 3,
    captureTtlMinutes: 5,
    imageMinShortEdge: 800,
    imageIgnoreShortEdge: 300,
    imageQualityGateEnabled: true,
    imageMinSharpness: 40,
    imageSoftSharpness: 120,
    imageMinBrightness: 45,
    imageMinLongEdge: 640,
    selftestForAsk: false,
    selftestMaxAttempts: 6,
    selftestMaxCaseFailures: 3,
    selftestRepeatLimit: 2,
    selftestEscalations: 1,
    selftestCompileTimeoutMs: 10_000,
    selftestCaseTimeoutMs: 3_000,
    selftestBudgetSeconds: 170,
    requestWatchdogSeconds: 180,
    selftestProgressSeconds: 30,
    selftestProgressMaxFrames: 4,
    selftestLogPath: join(homedir(), 'rokid-bridge', 'selftest.log'),
    selftestWorkDir: '',
    selftestWslDistro: '',
    selftestAckText: '（正在生成并编译验证，稍等）',
    selftestPersonaNote: '（说明：主机侧会对你的代码做真实编译与用例验证，你不需要声明“没有运行过”，也不要写“验证过程没有运行”这类话；直接给出你认为正确的最终版即可。）',
    selftestDebugBreak: 'off',
    selftestKeepWorkDir: false,
}

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const DEFAULT_SYSTEM_PROMPT =
    '你是戴在用户眼镜上的私人助手。回答简短、口语化，控制在 60 字以内，先给结论。'
    + '收到图片时先点出画面里的关键信息，再给判断或建议。不要输出 Markdown、表格和长列表。'
const IMAGE_ONLY_PROMPT = '看看画面里有什么，用一两句话说重点。'
const IMAGE_TIMEOUT_MS = 15_000
const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_FAIL_TEXT = '（图片下载失败）'
const BODY_MAX_BYTES = 32 * 1024 * 1024
const RAW_MAX_BYTES = 12 * 1024 * 1024
const RAW_DEFAULT_PROMPT = '这是一道编程题的照片，请按系统提示解答。'
const CHAT_PATHS = new Set(['/chat', '/rokid/chat'])
const ASK_PATHS = new Set(['/ask', '/rokid/ask'])
const RAW_PATHS = new Set(['/ask-raw', '/rokid/ask-raw'])
const HEALTH_PATHS = new Set(['/health', '/'])
const KNOWN_PATHS = new Set([...CHAT_PATHS, ...ASK_PATHS, ...RAW_PATHS, ...HEALTH_PATHS])

// ── optional shipped packages, resolved through the profile's module tree ────
const requireFromHere = createRequire(import.meta.url)

function moduleSearchPaths() {
    const paths = []
    const push = (value) => {
        if (typeof value === 'string' && value !== '' && !paths.includes(value)) paths.push(value)
    }
    const profileDir = process.env.DSH_PROFILE_DIR
    const dshHome = process.env.DSH_HOME
    push(typeof profileDir === 'string' ? join(profileDir, 'node_modules') : undefined)
    if (typeof dshHome === 'string' && dshHome !== '') {
        push(join(dshHome, 'profiles', 'node_modules'))
        push(join(dshHome, 'node_modules'))
    }
    // The Host process may not export DSH_HOME; the default home and the Electron
    // bundled installation are the two remaining places the packages live.
    push(join(homedir(), '.dsh', 'profiles', 'node_modules'))
    push(join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop', 'node_modules'))
    push(join(homedir(), '.dsh', 'node_modules'))
    const resources = /** @type {any} */ (process).resourcesPath
    push(typeof resources === 'string' ? join(resources, 'app.asar', 'dsh', 'node_modules') : undefined)
    push(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
    return paths
}

/** A linked bundle lives outside the profile, so resolve through the profile tree. */
function loadShippedPackage(specifier) {
    try {
        return requireFromHere(specifier)
    } catch {
        // fall through to the profile search paths
    }
    for (const base of moduleSearchPaths()) {
        try {
            return requireFromHere(requireFromHere.resolve(specifier, { paths: [base] }))
        } catch {
            // try the next base
        }
    }
    return undefined
}

const schemastery = loadShippedPackage('@deepseek-ai/schemastery') ?? loadShippedPackage('schemastery')
const Schema = schemastery?.default ?? schemastery
const llmPackage = loadShippedPackage('@deepseek-ai/dsh-llm')
const createUserMessage = typeof llmPackage?.createUserMessage === 'function' ? llmPackage.createUserMessage : undefined
const sharpPackage = loadShippedPackage('sharp')
const sharpFn = sharpPackage?.default ?? sharpPackage

/**
 * Objective quality metrics: Laplacian variance (how sharp the edges are) and mean
 * brightness. Calibrated on screen photos: sharp page ≈ 1000+, mild shake ≈ 500,
 * visibly blurred ≈ 10–20, small-text blurred ≈ 11.
 */
async function measureImageQuality(bytes) {
    if (typeof sharpFn !== 'function') return null
    try {
        const metadata = await sharpFn(Buffer.from(bytes)).metadata()
        const { data, info } = await sharpFn(Buffer.from(bytes))
            .greyscale()
            .resize({ width: 480, withoutEnlargement: true })
            .raw()
            .toBuffer({ resolveWithObject: true })
        const width = info.width
        const height = info.height
        let brightnessSum = 0
        for (let index = 0; index < data.length; index += 1) brightnessSum += data[index]
        let sum = 0
        let sumSquares = 0
        let count = 0
        for (let y = 1; y < height - 1; y += 1) {
            for (let x = 1; x < width - 1; x += 1) {
                const index = y * width + x
                const laplacian = 4 * data[index] - data[index - 1] - data[index + 1] - data[index - width] - data[index + width]
                sum += laplacian
                sumSquares += laplacian * laplacian
                count += 1
            }
        }
        const mean = count > 0 ? sum / count : 0
        return {
            originalWidth: metadata.width ?? 0,
            originalHeight: metadata.height ?? 0,
            bytes: bytes.byteLength,
            width: info.width,
            height: info.height,
            sharpness: count > 0 ? Math.round(sumSquares / count - mean * mean) : 0,
            brightness: Math.round(brightnessSum / Math.max(1, data.length)),
        }
    } catch {
        return null
    }
}

export const Config = typeof Schema?.object === 'function' ? Schema.object({
    host: Schema.string().default(DEFAULTS.host).description('绑定地址；只绑回环，别改成 0.0.0.0。'),
    port: Schema.natural().default(DEFAULTS.port).description('监听端口。8091 = 测试口；线上 8090 由 ECS 隧道指向。'),
    accessKey: Schema.string().default(DEFAULTS.accessKey).description('灵珠自定义智能体 AK；留空则回退读取 legacyConfigPath 里的 rokid_ak。'),
    legacyConfigPath: Schema.string().default(DEFAULTS.legacyConfigPath).description('过渡期复用的 Python bridge 配置，只在 accessKey/systemPrompt 留空时读取。'),
    logPath: Schema.string().default(DEFAULTS.logPath).description('运行日志文件（UTF-8 追加写入，含 [REQ]/[RESP]/[SELFTEST] 行）；留空则只写 DSH 进程日志。'),
    systemPrompt: Schema.string().default(DEFAULTS.systemPrompt).description('眼镜端人设提示词；留空则复用 legacy 配置的 system_prompt。'),
    workspace: Schema.string().default(DEFAULTS.workspace).description('眼镜会话的工作目录；留空 = ~/rokid-bridge/agent-workspace。'),
    sandboxMode: Schema.string().default(DEFAULTS.sandboxMode).description('眼镜会话的沙箱模式：read-only / workspace-write / danger-full-access。'),
    agentPreset: Schema.string().default(DEFAULTS.agentPreset).description('眼镜会话使用的 agent preset；留空 = 当前默认预设（工具集随预设走）。'),
    reasoningEffort: Schema.string().default(DEFAULTS.reasoningEffort).description('覆盖思考强度（如 max）；留空沿用 DSH 当前选择。'),
    idleMinutes: Schema.natural().default(DEFAULTS.idleMinutes).description('设备会话空闲多久后回收（分钟）。'),
    maxDevices: Schema.natural().default(DEFAULTS.maxDevices).description('同时保留的设备会话上限，超出按最久未用回收。'),
    maxConcurrent: Schema.natural().default(DEFAULTS.maxConcurrent).description('同时在跑的请求上限，超出返回 429。'),
    turnTimeoutSeconds: Schema.natural().default(DEFAULTS.turnTimeoutSeconds).description('单次回答的墙钟预算（秒），到点取消本轮。'),
    heartbeatSeconds: Schema.natural().default(DEFAULTS.heartbeatSeconds).description('SSE 注释心跳间隔（秒）；文档要求 8–10 秒一行，默认 9。'),
    selftestEnabled: Schema.boolean().default(DEFAULTS.selftestEnabled).description('回答里含 C++ 代码时，先在主机上编译并跑用例，通过后再吐最终版。'),
    takeOverLegacyPort: Schema.boolean().default(DEFAULTS.takeOverLegacyPort).description('端口被旧的 Python 桥（rokid_bridge.py）占用时，结束后者的进程再接管端口；关闭则只报错不接管。'),
    imageTriageEnabled: Schema.boolean().default(DEFAULTS.imageTriageEnabled).description('带图请求先做一次「拍全了没有／看得清吗」预检；不合格就直接让用户重拍，不再硬答。'),
    imageTriageTimeoutSeconds: Schema.natural().default(DEFAULTS.imageTriageTimeoutSeconds).description('图片预检的超时（秒）；超时按放行处理。'),
    imageAckText: Schema.string().default(DEFAULTS.imageAckText).description('收到带图请求时先发的回执帧（文档要求 200ms 内、不超过 12 字）。'),
    takePhotoEnabled: Schema.boolean().default(DEFAULTS.takePhotoEnabled).description('是否下发 tool_call take_photo 让眼镜自动拍照。实测灵珠侧暂不响应，默认关闭；关闭时只回文字提示让用户手动重拍。'),
    takePhotoCooldownSeconds: Schema.natural().default(DEFAULTS.takePhotoCooldownSeconds).description('同一会话两次自动拍照的最小间隔（秒），防死循环。'),
    imageMaxCaptures: Schema.natural().default(DEFAULTS.imageMaxCaptures).description('同一会话最多自动补拍几张，之后必须用现有照片作答。'),
    captureTtlMinutes: Schema.natural().default(DEFAULTS.captureTtlMinutes).description('连续补拍会话的内存保留时长（分钟），超时清空。'),
    imageMinShortEdge: Schema.natural().default(DEFAULTS.imageMinShortEdge).description('原图短边低于此值判为“太小/被裁”，要求重拍。'),
    imageIgnoreShortEdge: Schema.natural().default(DEFAULTS.imageIgnoreShortEdge).description('短边低于此值的图直接当“快捷方式带的残图”丢弃（不参与判定、不计补拍次数）。'),
    imageQualityGateEnabled: Schema.boolean().default(DEFAULTS.imageQualityGateEnabled).description('拍照糊了/太暗时直接要求重拍（用主机侧清晰度、亮度指标判定）。'),
    imageMinSharpness: Schema.natural().default(DEFAULTS.imageMinSharpness).description('清晰度指数低于此值判为“糊了，必须重拍”。拍屏清晰约 1000+，轻微手抖约 500，明显糊 10–20。'),
    imageSoftSharpness: Schema.natural().default(DEFAULTS.imageSoftSharpness).description('清晰度指数低于此值但高于下限时，作答但附带“画面有点虚”的提醒。'),
    imageMinBrightness: Schema.natural().default(DEFAULTS.imageMinBrightness).description('平均亮度低于此值判为“太暗”，要求补光重拍。'),
    imageMinLongEdge: Schema.natural().default(DEFAULTS.imageMinLongEdge).description('原图长边低于此值判为“分辨率偏低”：低于一半直接要求重拍，介于两者之间作答并提示。'),
    selftestForAsk: Schema.boolean().default(DEFAULTS.selftestForAsk).description('/ask 是否也走自检（默认只走 /chat）。'),
    selftestMaxAttempts: Schema.natural().default(DEFAULTS.selftestMaxAttempts).description('一次机械重写阶段内最多编译+跑用例的次数（含首次）；到顶转交 agent 调试。'),
    selftestMaxCaseFailures: Schema.natural().default(DEFAULTS.selftestMaxCaseFailures).description('同一组用例最多失败几次（默认 3）。'),
    selftestRepeatLimit: Schema.natural().default(DEFAULTS.selftestRepeatLimit).description('出现完全相同的失败连续几次就停止机械重写（默认 2，防死循环）。'),
    selftestEscalations: Schema.natural().default(DEFAULTS.selftestEscalations).description('机械重写卡住后，交给 agent 亲自用工具调试的次数（默认 1，0 = 直接按上限收尾）。'),
    selftestCompileTimeoutMs: Schema.natural().default(DEFAULTS.selftestCompileTimeoutMs).description('单次编译超时（毫秒）。'),
    selftestCaseTimeoutMs: Schema.natural().default(DEFAULTS.selftestCaseTimeoutMs).description('单组用例运行超时（毫秒）。'),
    selftestBudgetSeconds: Schema.natural().default(DEFAULTS.selftestBudgetSeconds).description('自检看门狗（秒）：到点强制收尾，返回最后一版并标注未通过；0 = 不限。'),
    requestWatchdogSeconds: Schema.natural().default(DEFAULTS.requestWatchdogSeconds).description('整次请求的看门狗（秒）：到点强制发 is_finish + event:done，绝不让请求无限挂着；0 = 不限。'),
    selftestProgressSeconds: Schema.natural().default(DEFAULTS.selftestProgressSeconds).description('长任务期间每隔多少秒发一句「还在处理中，已用时 N 秒」。'),
    selftestProgressMaxFrames: Schema.natural().default(DEFAULTS.selftestProgressMaxFrames).description('这类进度提示最多发几帧，防止刷屏。'),
    selftestLogPath: Schema.string().default(DEFAULTS.selftestLogPath).description('自检日志文件路径（追加写入 [SELFTEST] 行）。'),
    selftestWorkDir: Schema.string().default(DEFAULTS.selftestWorkDir).description('编译临时目录；留空 = <workspace>/selftest。'),
    selftestWslDistro: Schema.string().default(DEFAULTS.selftestWslDistro).description('跑 g++ 的 WSL 发行版；留空 = 默认发行版。'),
    selftestAckText: Schema.string().default(DEFAULTS.selftestAckText).description('检测到代码后、开始编译前先发给眼镜的一句话。'),
    selftestPersonaNote: Schema.string().default(DEFAULTS.selftestPersonaNote).description('自检开启时追加在人设后面的一句说明，避免模型自称“没有运行验证”。'),
    selftestDebugBreak: Schema.string().default(DEFAULTS.selftestDebugBreak).description('调试开关：off / compile（故意注入编译错误）/ logic（故意污染期望输出），用来验证回灌链路。'),
    selftestKeepWorkDir: Schema.boolean().default(DEFAULTS.selftestKeepWorkDir).description('保留每次编译的临时目录，便于事后看 main.cpp 与输出。'),
}) : undefined

/**
 * Mount the bridge listener.
 * @param ctx - the plugin context.
 * @param config - the plugin row config (validated only when Config is exported).
 * @returns nothing; every owned resource is disposed with the plugin fiber.
 */
export function apply(ctx, config) {
    const cfg = normalizeConfig(config)
    const state = {
        states: new Map(),
        inFlight: 0,
        reaper: undefined,
        accessKey: '',
        systemPrompt: '',
        workspace: '',
    }
    const inFlightAborts = new Set()

    const log = (level, message) => {
        try {
            const logger = ctx.logger
            if (logger && typeof logger[level] === 'function') logger[level](`[rokid] ${message}`)
            else console[level === 'error' ? 'error' : 'log'](`[rokid] ${message}`)
        } catch {
            // logging must never break a request
        }
        // Always mirror into a plain UTF-8 file: the Python bridge's log was hijacked
        // into UTF-16LE by the scheduled task's PowerShell redirection.
        if (String(cfg.logPath || '').trim() !== '') {
            void appendSelfTestLog(cfg.logPath, `[${String(level).toUpperCase()}] ${message}`)
        }
    }

    // ── configuration ────────────────────────────────────────────────────────
    const legacy = readLegacyConfig(cfg.legacyConfigPath)
    state.accessKey = String(cfg.accessKey || legacy.rokidAk || '').trim()
    state.systemPrompt = String(cfg.systemPrompt || legacy.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim()
    state.workspace = String(cfg.workspace || '').trim() || join(homedir(), 'rokid-bridge', 'agent-workspace')
    if (state.accessKey === '') {
        log('error', '没有可用的 AK（config.accessKey 与 legacy 配置都为空）：所有请求都会被 401 拒绝')
    }

    // ── real self-test: compile + run in WSL before the answer is streamed ───
    cfg.selftestWorkDir = String(cfg.selftestWorkDir || '').trim() || join(state.workspace, 'selftest')

    async function llmText({ system, prompt, signal }) {
        const selection = ctx.agentDefaultModel.currentSelection()
        const parts = []
        let failure
        for await (const chunk of ctx.llm.stream({
            provider: selection.provider,
            model: selection.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            system,
            signal,
        })) {
            if (chunk.type === 'text-delta') parts.push(chunk.text)
            else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                failure = chunk.reason.failure
            }
        }
        if (failure !== undefined) {
            throw new Error(`${failure.code ?? 'LLM_FAILED'}: ${failure.message ?? 'stream failed'}`)
        }
        return parts.join('')
    }

    const verifier = createSelfTest({ llmText, escalate: escalateToAgent, log, config: cfg })

    /** Completeness pre-check (doc §7.2): can the photo support answering, and what is missing? */
    async function precheckImage({ imageBlocks, text, signal, metrics }) {
        const selection = ctx.agentDefaultModel.currentSelection()
        const prompt = [
            '你是题目完整性检查器，只检查照片够不够用来解题，不要解题。',
            '逐项检查：题干文字、输入输出样例、数据范围，是否齐全、是否被截断、是否反光或模糊到读不出。',
            '只输出一个 JSON 对象，不要解释、不要代码围栏：',
            '{"complete": true 或 false, "missing": ["缺少的项"], "reason": "一句话说明"}',
            '只要题干、样例、数据范围缺任何一项，或关键文字读不清，就判 complete=false，并在 missing 里写明缺什么（例如「输入输出样例」「数据范围」「题干下半页」「右下角被截断」）。',
            '如果图片不是文字题目（风景、物品、人脸等），一律 complete=true、missing=[]。',
            metrics === null || metrics === undefined
                ? ''
                : `主机客观指标：清晰度指数 ${metrics.sharpness}（低于 ${cfg.imageMinSharpness} 基本是糊的，${cfg.imageSoftSharpness} 以下偏虚），`
                    + `平均亮度 ${metrics.brightness}（低于 ${cfg.imageMinBrightness} 太暗），`
                    + `原图 ${metrics.originalWidth}×${metrics.originalHeight} 像素（短边低于 ${cfg.imageMinShortEdge} 视为太小或被裁）。`,
            `用户原话：${text || '（未说具体问题）'}`,
        ].filter((line) => line !== '').join('\n')
        let output = ''
        try {
            for await (const chunk of ctx.llm.stream({
                provider: selection.provider,
                model: selection.model,
                messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
                maxTokens: 400,
                signal: withTimeout(signal, Math.max(5, cfg.imageTriageTimeoutSeconds) * 1000),
            })) {
                if (chunk.type === 'text-delta') output += chunk.text
                else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                    log('warn', '[PRECHECK] 完整性检查调用失败，降级放行')
                    return null
                }
            }
        } catch (error) {
            log('warn', `[PRECHECK] 完整性检查异常，降级放行：${describeError(error)}`)
            return null
        }
        const verdict = parseJsonObject(output)
        if (verdict === null || typeof verdict.complete !== 'boolean') {
            log('warn', `[PRECHECK] 结果解析失败，降级放行：${String(output).slice(0, 120)}`)
            return null
        }
        const missing = Array.isArray(verdict.missing)
            ? verdict.missing.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
            : []
        return {
            complete: verdict.complete === true,
            missing,
            reason: String(verdict.reason ?? ''),
        }
    }

    /** Run one hidden turn on a throwaway agent so debug prompts never pollute the user session. */
    async function runEphemeralTurn(text, signal) {
        const agentState = {
            key: 'selftest-debug',
            agent: undefined,
            dispose: undefined,
            chain: Promise.resolve(),
            lastUsed: Date.now(),
            ready: undefined,
            current: undefined,
            lastAssistantText: '',
            sessionId: `rokid-debug-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
        }
        const mapKey = `${agentState.key}:${agentState.sessionId}`
        agentState.ready = createAgent(agentState)
        state.states.set(mapKey, agentState)
        try {
            await agentState.ready
            return await runTurn(agentState, [{ type: 'text', text }], () => {}, signal)
        } finally {
            state.states.delete(mapKey)
            cancelQuietly(agentState.agent, 'debug session done')
            try {
                await agentState.dispose?.()
            } catch {
                // disposal failure must not mask the verification result
            }
        }
    }

    /** Hand a stuck verification to the device agent, which can compile and debug with tools. */
    async function escalateToAgent({ code, problem, error, cases, failedCase, deviceId, signal }) {
        const caseText = (Array.isArray(cases) ? cases : [])
            .map((item, index) => `#${index + 1} 输入 ${JSON.stringify(item.input)} → 期望 ${JSON.stringify(item.expected)}`
                + (index === failedCase ? '（这组未通过）' : ''))
            .join('\n')
        const prompt = [
            '（主机自检求助）下面这段 C++ 答案在主机上真实编译并跑用例没通过，机械重写多次仍然失败。',
            '请你亲自用工具调试：把代码写到工作目录 <' + state.workspace + '> 下，用 wsl 里的 g++ 编译，',
            '用失败那组输入真的跑一遍，确认通过后再给出最终代码。',
            '',
            '题目/需求：',
            clipText(problem, 1200),
            '',
            '当前代码：',
            code,
            '',
            '测试用例：',
            caseText,
            '',
            '主机实测结果：',
            clipText(error, 1500),
            '',
            '要求：只改代码，不要改用例；如果判定某组用例的期望值本身写错了，最后单独写一行 CASE-SUSPECT: #<序号>。',
            '最后只输出完整的 C++ 源码（从 #include 开始），不要解释。',
        ].join('\n')
        const job = await runEphemeralTurn(prompt, signal)
        const extracted = extractCode(job.text)
        const suspect = /CASE-SUSPECT\s*:\s*#\s*\d+/iu.test(job.text)
        if (suspect) log('warn', '[SELFTEST] agent 认为某组用例的期望值可能写错了')
        return { code: extracted?.code ?? null, caseSuspect: suspect }
    }

    // ── listener ─────────────────────────────────────────────────────────────
    const server = createServer((req, res) => {
        handle(req, res).catch((error) => {
            log('error', `未捕获的请求异常：${describeError(error)}`)
            if (res.headersSent) {
                try {
                    res.end()
                } catch {
                    // already gone
                }
                return
            }
            sendJson(res, 500, { error: 'internal error' })
        })
    })
    server.on('clientError', (error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        log('warn', `clientError: ${describeError(error)}`)
    })
    server.on('listening', () => {
        void mkdir(state.workspace, { recursive: true }).catch((error) => {
            log('warn', `工作目录创建失败 ${state.workspace}: ${describeError(error)}`)
        })
        log('info', `v${VERSION} 监听 http://${cfg.host}:${cfg.port} | workspace=${state.workspace}`
            + ` | legacy=${legacy.used ? 'ok' : 'none'} | schema=${typeof Schema?.object === 'function' ? 'on' : 'off'}`)
    })
    let takeoverTries = 0
    server.on('error', (error) => {
        if (error?.code === 'EADDRINUSE' && cfg.takeOverLegacyPort === true && process.platform === 'win32') {
            void takeOverLegacyPort()
            return
        }
        log('error', `监听失败 ${cfg.host}:${cfg.port}: ${describeError(error)}`)
    })

    /** The old Python bridge restarts at logon; take the port back from it. */
    async function takeOverLegacyPort() {
        if (takeoverTries >= 3) {
            log('error', `端口 ${cfg.port} 仍被占用，放弃接管（可手动停掉旧桥后重启插件）`)
            return
        }
        takeoverTries += 1
        const owner = await findPortOwner(cfg.port).catch(() => null)
        const ownerName = String(owner?.name ?? '')
        const commandLine = String(owner?.commandLine ?? '')
        const looksLegacy = /^python/iu.test(ownerName) || /rokid_bridge\.py/iu.test(commandLine)
        if (owner !== null && !looksLegacy) {
            log('error', `端口 ${cfg.port} 被其它进程占用（pid=${owner.pid} ${ownerName}），不接管`)
            return
        }
        log('warn', `端口 ${cfg.port} 被旧桥占用（pid=${owner?.pid ?? '?'} ${ownerName || 'unknown'}），执行接管`)
        // The task's process tree may run with higher rights than this process, so
        // stopping the scheduled task is the reliable way to clear the port.
        await runPowerShell("Stop-ScheduledTask -TaskName 'Rokid-Bridge' -ErrorAction SilentlyContinue").catch(() => {})
        if (owner !== null) {
            await runPowerShell(`Stop-Process -Id ${owner.pid} -Force -ErrorAction SilentlyContinue`).catch(() => {})
        }
        await delay(1_500)
        relisten()
    }

    function relisten() {
        try {
            server.listen(cfg.port, cfg.host)
        } catch (error) {
            log('error', `重新监听 ${cfg.port} 失败: ${describeError(error)}`)
        }
    }

    server.listen(cfg.port, cfg.host)

    const reaper = setInterval(() => {
        void reapIdle()
    }, 60_000)
    reaper.unref?.()

    ctx.effect(() => () => {
        clearInterval(reaper)
        // Kill every in-flight request (and its verification loop) immediately; a
        // reload must not leave a repair loop running for minutes.
        for (const controller of inFlightAborts) {
            try {
                controller.abort(new Error('plugin disposed'))
            } catch {
                // ignore
            }
        }
        inFlightAborts.clear()
        try {
            server.closeAllConnections?.()
            server.close()
        } catch {
            // already closed
        }
        for (const agentState of state.states.values()) {
            try {
                agentState.agent?.cancel({ kind: 'disposed' })
            } catch {
                // ignore
            }
            void agentState.dispose?.().catch(() => {})
        }
        state.states.clear()
    }, 'rokid-bridge-dsh: listener + agent sessions')

    // ── HTTP routing ─────────────────────────────────────────────────────────
    async function handle(req, res) {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/u, '') || '/'
        if (!KNOWN_PATHS.has(pathname)) {
            sendJson(res, 404, { error: 'not found' })
            return
        }
        if (HEALTH_PATHS.has(pathname)) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { error: 'method not allowed' })
                return
            }
            sendJson(res, 200, { status: 'ok', service: 'rokid-bridge' })
            return
        }
        if (!authorize(req)) {
            sendJson(res, 401, { error: 'unauthorized' })
            return
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
        }
        if (state.inFlight >= cfg.maxConcurrent) {
            log('warn', `并发上限 ${cfg.maxConcurrent} 已满，拒绝 ${pathname}`)
            sendJson(res, 429, { error: 'busy' })
            return
        }
        // Raw binary path: handled before readJsonBody() so image bytes never touch
        // JSON.parse — a 3024x4032 JPEG arrives as-is and is base64-encoded here.
        if (RAW_PATHS.has(pathname)) {
            await handleAskRaw(req, res)
            return
        }

        let body
        try {
            body = await readJsonBody(req, BODY_MAX_BYTES)
        } catch (error) {
            sendJson(res, error?.status ?? 400, { error: describeError(error) })
            return
        }

        state.inFlight += 1
        try {
            if (ASK_PATHS.has(pathname)) await handleAsk(req, res, body)
            else await handleChat(req, res, body)
        } finally {
            state.inFlight -= 1
        }
    }

    // ── POST /ask-raw ───────────────────────────────────────────────────────
    // The glasses' AIUI runtime has no guaranteed FileReader / canvas.toDataURL and
    // a 3–5MB photo base64'd on-device risks OOM (+33% upload), so the app POSTs the
    // Blob itself; the host does the conversion and reuses the /ask answer path.
    async function handleAskRaw(req, res) {
        const startedAt = Date.now()
        const url = new URL(req.url ?? '/', 'http://localhost')
        const question = String(url.searchParams.get('q') ?? '').trim() || RAW_DEFAULT_PROMPT
        const deviceId = String(url.searchParams.get('device_id') ?? url.searchParams.get('user_id') ?? '').trim().slice(0, 120) || 'glasses'
        const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        const mime = declared === '' ? 'image/jpeg' : declared
        const brief = question.replace(/\s+/gu, ' ').slice(0, 40)
        const logLine = (bytes, answerLength) => log('info',
            `[RAW] bytes=${bytes} mime=${mime} q=${brief} answer_len=${answerLength} ms=${Date.now() - startedAt}`)

        const declaredLength = Number(req.headers['content-length'] ?? Number.NaN)
        if (Number.isFinite(declaredLength) && declaredLength > RAW_MAX_BYTES) {
            log('warn', `[RAW] 请求体 ${declaredLength} 字节，超过上限 ${RAW_MAX_BYTES}，返回 413`)
            logLine(declaredLength, 0)
            sendJson(res, 413, { error: 'image too large' })
            drainRequest(req, RAW_MAX_BYTES * 4)
            return
        }

        let bytes
        try {
            bytes = await readRawBody(req, RAW_MAX_BYTES)
        } catch (error) {
            const seen = Number.isFinite(declaredLength) ? declaredLength : (Number.isFinite(error?.bytes) ? error.bytes : 0)
            logLine(seen, 0)
            sendJson(res, error?.status ?? 400, { error: error?.status === 413 ? 'image too large' : describeError(error) })
            return
        }
        if (bytes.byteLength === 0) {
            logLine(0, 0)
            sendJson(res, 400, { error: 'missing image' })
            return
        }

        state.inFlight += 1
        try {
            const answer = await handleAsk(req, res, {
                device_id: deviceId,
                text: question,
                image: { data: bytes.toString('base64'), mime_type: mime },
            }, '/ask-raw')
            logLine(bytes.byteLength, String(answer ?? '').length)
        } finally {
            state.inFlight -= 1
        }
    }

    function authorize(req) {
        if (state.accessKey === '') return false
        const header = req.headers.authorization
        if (typeof header !== 'string') return false
        const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
        if (match === null) return false
        const presented = Buffer.from(match[1].trim(), 'utf8')
        const expected = Buffer.from(state.accessKey, 'utf8')
        return expected.length === presented.length && timingSafeEqual(expected, presented)
    }

    // ── POST /ask ────────────────────────────────────────────────────────────
    // `route` only labels the log lines; /ask-raw reuses this exact pipeline so both
    // endpoints answer identically for the same image + question.
    async function handleAsk(req, res, body, route = '/ask') {
        const deviceId = String(body?.device_id || body?.user_id || 'glasses').slice(0, 120)
        const text = String(body?.text ?? '').trim()
        const content = []
        const image = body?.image
        if (image !== null && typeof image === 'object' && typeof image.data === 'string' && image.data !== '') {
            const saved = await saveEncodedImage(image.data, image.mime_type)
            if (saved !== null) {
                content.push({ type: 'text', text: text || IMAGE_ONLY_PROMPT })
                content.push({ type: 'image', attachment: saved.ref })
            }
        }
        if (content.length === 0) {
            if (text === '') {
                sendJson(res, 422, { error: 'text 与 image 至少要有一个' })
                return
            }
            content.push({ type: 'text', text })
        }
        log('info', `[REQ] POST ${route} device=${deviceId} text_len=${text.length}`)
        try {
            const job = await enqueue(deviceId, (agentState) => runTurn(agentState, content, () => {}, undefined))
            let answer = job.text.trim()
            if (cfg.selftestForAsk && answer !== '') {
                const verified = await verifier.verify({
                    answer: job.text,
                    requestText: text || '（用户只发了图片，请按画面里的题目作答）',
                    deviceId,
                    requestId: 'ask',
                })
                answer = verified.answer.trim()
                if (verified.status === 'skipped') {
                    if (/compiler missing/u.test(String(verified.logLine || ''))) answer = `${answer}\n\n（本机没有可用的编译器，未做编译验证）`
                    else if (/#include|int\s+main\s*\(|```/u.test(answer)) answer = `${answer}\n\n（代码没能提取出来，未做编译验证）`
                }
                else if (verified.status === 'no-cases') answer = `${answer}\n\n（主机没有拿到可用测试用例，未做编译验证）`
                log('info', `${verified.logLine} device=${deviceId} msg=ask`)
                void appendSelfTestLog(cfg.selftestLogPath, `${verified.logLine} device=${deviceId} msg=ask status=${verified.status}`)
            }
            const finalAnswer = answer === '' ? fallbackText(job) : answer
            log('info', `[RESP] 200 ${route} device=${deviceId} chars=${finalAnswer.length}`)
            sendJson(res, 200, { answer: finalAnswer })
            return finalAnswer
        } catch (error) {
            log('error', `[RESP] 502 ${route} device=${deviceId}: ${describeError(error)}`)
            sendJson(res, 502, { error: describeError(error).slice(0, 300) })
            return undefined
        }
    }

    // ── §8/§9 capture sessions: one logical photo session per user ───────────
    const captureSessions = new Map()
    const lastTakePhoto = new Map()

    function captureKeyOf(body) {
        const context = body?.metadata?.context
        const raw = context?.session_id ?? body?.user_id ?? body?.device_id ?? 'glasses'
        return String(raw ?? 'glasses').slice(0, 120)
    }

    function loadCapture(key) {
        const entry = captureSessions.get(key)
        if (entry === undefined) return null
        if (Date.now() - entry.lastTs > Math.max(1, cfg.captureTtlMinutes) * 60_000) {
            captureSessions.delete(key)
            return null
        }
        return entry
    }

    function newCapture() {
        return { images: [], captures: 0, lastTs: Date.now(), lastText: '', lastProblem: '', lastMissing: '' }
    }

    /** A noticeably different question starts a fresh capture session (§9.2). */
    function captureShouldReset(entry, text) {
        const previous = String(entry.lastText ?? '').trim()
        const current = String(text ?? '').trim()
        if (previous === '' || current === '' || previous === current) return false
        const pool = new Set([...previous])
        let common = 0
        for (const character of current) if (pool.has(character)) common += 1
        return common / current.length < 0.3
    }

    function takePhotoCooling(key) {
        const at = lastTakePhoto.get(key)
        if (at === undefined) return false
        return Date.now() - at < Math.max(5, cfg.takePhotoCooldownSeconds) * 1000
    }

    function markTakePhoto(key) {
        lastTakePhoto.set(key, Date.now())
    }

    /** §8: does this text ask for a look, i.e. should the glasses shoot first? */
    function needsPhoto(text) {
        const value = String(text ?? '').trim()
        if (value === '') return false
        return /看|题|图|拍|照片/iu.test(value)
    }

    /** Objective problem with the newest photo, or null when usable. */
    function qualityProblem(quality) {
        if (quality === null || quality === undefined) return null
        const width = Number(quality.originalWidth) || 0
        const height = Number(quality.originalHeight) || 0
        const shortEdge = width > 0 && height > 0 ? Math.min(width, height) : 0
        if (quality.brightness < cfg.imageMinBrightness) return '画面太暗，看不清字。'
        if (quality.sharpness < cfg.imageMinSharpness) return '画面糊了，文字读不出来。'
        if (shortEdge > 0 && shortEdge < cfg.imageMinShortEdge) return `照片太小（${width}×${height}），细节不够。`
        return null
    }

    /** Advisory note for photos that are usable but not great. */
    function qualitySoftNote(quality) {
        if (quality === null || quality === undefined) return ''
        const notes = []
        if (quality.sharpness < cfg.imageSoftSharpness) notes.push('画面有点发虚')
        const width = Number(quality.originalWidth) || 0
        const height = Number(quality.originalHeight) || 0
        if (width > 0 && height > 0) {
            const shortEdge = Math.min(width, height)
            if (shortEdge >= cfg.imageMinShortEdge && shortEdge < cfg.imageMinLongEdge) {
                notes.push(`照片只有 ${width}×${height}`)
            }
        }
        return notes.join('，')
    }

    // ── POST /chat (Lingzhu named-event SSE) ─────────────────────────────────
    async function handleChat(req, res, body) {
        const deviceId = String(body?.user_id || body?.device_id || 'glasses').slice(0, 120)
        const messageId = String(body?.message_id || `msg-${randomUUID()}`)
        const agentId = String(body?.agent_id || '')

        // The doc requires a first frame inside one second: open the stream and say we
        // are working before downloading images or calling the model.
        const started = Date.now()
        let firstFrameAt
        let finished = false
        let watchdog
        let abortController
        let triageNote = ''
        let precheckSkipped = false
        let triageMs = 0
        let turnMs = 0
        let verifyMs = 0

        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        })
        res.socket?.setNoDelay?.(true)
        res.write(': connected\n\n')

        const sendAnswer = (text, isFinish) => {
            if (finished || res.writableEnded) return
            if (isFinish === false && firstFrameAt === undefined) firstFrameAt = Date.now() - started
            try {
                res.write(`event:message\ndata:${JSON.stringify({
                    role: 'agent',
                    type: 'answer',
                    answer_stream: text,
                    message_id: messageId,
                    agent_id: agentId,
                    is_finish: isFinish,
                })}\n\n`)
            } catch {
                // the client may have gone away mid-answer
            }
        }

        const heartbeat = setInterval(() => {
            if (finished || res.writableEnded) return
            try {
                res.write(': heartbeat\n\n')
            } catch {
                // connection gone; 'close' finishes the turn
            }
        }, Math.max(1, cfg.heartbeatSeconds) * 1000)
        heartbeat.unref?.()

        const finish = (extraText) => {
            if (finished) return
            finished = true
            clearInterval(heartbeat)
            if (progressTimer !== undefined) clearInterval(progressTimer)
            if (watchdog !== undefined) clearTimeout(watchdog)
            if (abortController !== undefined) inFlightAborts.delete(abortController)
            if (extraText) sendAnswerInternal(extraText, false)
            sendAnswerInternal('', true)
            if (!res.writableEnded) {
                res.write('event:done\ndata:[DONE]\n\n')
                res.end()
            }
        }

        const sendAnswerInternal = (text, isFinish) => {
            if (res.writableEnded) return
            try {
                res.write(`event:message\ndata:${JSON.stringify({
                    role: 'agent',
                    type: 'answer',
                    answer_stream: text,
                    message_id: messageId,
                    agent_id: agentId,
                    is_finish: isFinish,
                })}\n\n`)
            } catch {
                // the client may have gone away mid-answer
            }
        }

        /** One `tool_call` frame asking the glasses to take a photo (§8.1). */
        const sendToolCall = (command) => {
            if (res.writableEnded) return
            try {
                res.write(`event:message\ndata:${JSON.stringify({
                    role: 'agent',
                    type: 'tool_call',
                    message_id: messageId,
                    agent_id: agentId,
                    is_finish: true,
                    tool_call: { command },
                })}\n\n`)
            } catch {
                // client already gone
            }
        }

        /** Finish this turn by telling the glasses to shoot; the photo arrives as a new request. */
        const finishWithTakePhoto = (text) => {
            if (finished) return
            finished = true
            clearInterval(heartbeat)
            if (progressTimer !== undefined) clearInterval(progressTimer)
            if (watchdog !== undefined) clearTimeout(watchdog)
            if (abortController !== undefined) inFlightAborts.delete(abortController)
            if (text) sendAnswerInternal(text, false)
            sendToolCall('take_photo')
            if (!res.writableEnded) {
                res.write('event:done\ndata:[DONE]\n\n')
                res.end()
            }
        }

        const abort = new AbortController()
        abortController = abort
        inFlightAborts.add(abort)
        if (cfg.requestWatchdogSeconds > 0) {
            watchdog = setTimeout(() => {
                log('warn', `[RESP] watchdog msg=${messageId}：${cfg.requestWatchdogSeconds} 秒到点强制收尾`)
                abort.abort(new Error('request watchdog'))
                finish(firstFrameAt === undefined
                    ? `[错误] 主机处理超时（${cfg.requestWatchdogSeconds} 秒），请再试一次`
                    : `（主机处理超时（${cfg.requestWatchdogSeconds} 秒），本次未完成验证）`)
            }, cfg.requestWatchdogSeconds * 1000)
            watchdog.unref?.()
        }
        const onClose = () => {
            if (!finished) abort.abort(new Error('client closed the connection'))
        }
        res.on('close', onClose)

        const selftestActive = cfg.selftestEnabled === true
        // §7.1: acknowledge a photo with its own short receipt line, inside 200ms.
        const requestHasImage = (Array.isArray(body?.message)
            && body.message.some((item) => {
                const type = String(item?.type ?? '').trim().toLowerCase()
                return type === 'image' || (type === '' && (item?.image_url ?? item?.imageUrl ?? '') !== '')
            }))
            || (typeof body?.image?.data === 'string' && body.image.data !== '')
        if (selftestActive) {
            sendAnswer(String(requestHasImage ? (cfg.imageAckText || '（已收到照片，检查题目）') : cfg.selftestAckText || ''), false)
        }

        // Keep the glasses informed during long verification: phase messages plus a
        // periodic "still working" line; both share one cap so the answer stays readable.
        let progressSent = 0
        const progressMax = Math.max(0, cfg.selftestProgressMaxFrames)
        const progress = (text) => {
            if (progressSent >= progressMax || abort.signal.aborted) return
            progressSent += 1
            sendAnswer(text, false)
        }
        let progressTimer
        if (selftestActive && cfg.selftestProgressSeconds > 0 && progressMax > 0) {
            progressTimer = setInterval(() => {
                const elapsed = Math.round((Date.now() - started) / 1000)
                progress(`（还在处理中，已用时 ${elapsed} 秒）`)
            }, cfg.selftestProgressSeconds * 1000)
            progressTimer.unref?.()
        }

        try {
            let parsed
            try {
                parsed = await parseLingzhuContent(body, req)
            } catch (error) {
                finish(`[错误] ${describeError(error)}`)
                return
            }
            if (parsed.content.length === 0) {
                finish('[错误] message 数组里没有可用内容')
                return
            }

            log('info', `[REQ] POST /chat device=${deviceId} msg=${messageId} text_len=${parsed.text.length}`
                + ` images=${parsed.images}${parsed.legacy ? ' legacy=1' : ''}`)

            // §8/§9: one capture session per user decides shoot-again vs answer.
            const captureKey = captureKeyOf(body)
            let capture = loadCapture(captureKey)
            if (capture !== null && captureShouldReset(capture, parsed.text)) {
                captureSessions.delete(captureKey)
                capture = null
            }
            const allImageBlocks = parsed.content.filter((block) => block?.type === 'image')
            const qualities = Array.isArray(parsed.qualities) ? parsed.qualities : []
            const paired = allImageBlocks.map((block, index) => ({ block, quality: qualities[index] ?? null }))
            const shortEdgeOf = (quality) => {
                if (quality === null || quality === undefined) return 0
                const width = Number(quality.originalWidth) || 0
                const height = Number(quality.originalHeight) || 0
                return width > 0 && height > 0 ? Math.min(width, height) : 0
            }
            // The shortcut always attaches a thin sliver of the screen: drop just those
            // images and treat the request as text-only instead of rejecting forever.
            const kept = paired.filter((item) => {
                const shortEdge = shortEdgeOf(item.quality)
                const isSliver = cfg.imageIgnoreShortEdge > 0
                    && shortEdge > 0
                    && shortEdge < cfg.imageIgnoreShortEdge
                if (isSliver) {
                    log('info', `[IMAGE] 忽略残图：original=${item.quality.originalWidth}x${item.quality.originalHeight}`
                        + `（短边 ${shortEdge} < ${cfg.imageIgnoreShortEdge}）`)
                }
                return !isSliver
            })
            const imageBlocks = kept.map((item) => item.block)
            const usableQualities = kept.map((item) => item.quality).filter((quality) => quality !== null)
            let worst = null
            for (const quality of usableQualities) {
                if (worst === null || quality.sharpness < worst.sharpness) worst = quality
            }
            if (worst !== null) {
                log('info', `[IMAGE] original=${worst.originalWidth}x${worst.originalHeight} (${worst.bytes}B)`
                    + ` saved=${worst.savedWidth ?? '?'}x${worst.savedHeight ?? '?'}`
                    + ` api=${worst.apiWidth ?? '?'}x${worst.apiHeight ?? '?'}`
                    + ` sharpness=${worst.sharpness} brightness=${worst.brightness}`)
            }
            const newRefs = imageBlocks.map((block) => block.attachment).filter(Boolean)

            if (paired.length > 0 && kept.length === 0 && parsed.text.trim() === '') {
                finish('这张照片只剩屏幕的一条边，没拍到题目。请用拍照按钮拍完整题目，或者直接把题目说给我听。')
                return
            }

            if (newRefs.length === 0) {
                // §8.1: a text request that obviously wants a look triggers a photo.
                if (cfg.takePhotoEnabled === true && needsPhoto(parsed.text) && !takePhotoCooling(captureKey)) {
                    markTakePhoto(captureKey)
                    log('info', `[TAKEPHOTO] 文本请求需要看图，发送 tool_call take_photo：${parsed.text.slice(0, 40)}`)
                    finishWithTakePhoto('')
                    return
                }
            } else {
                capture = capture === null ? newCapture() : capture
                capture.captures += 1
                capture.lastText = parsed.text
                capture.lastTs = Date.now()
                captureSessions.set(captureKey, capture)

                const problem = cfg.imageQualityGateEnabled === true ? qualityProblem(worst) : null
                if (problem !== null) {
                    log('info', `[IMAGE] 质量不合格：${problem}（第 ${capture.captures} 张）`)
                    const repeated = capture.lastProblem === problem
                    capture.lastProblem = problem
                    const canPrompt = capture.captures < cfg.imageMaxCaptures
                        && (cfg.takePhotoEnabled !== true || !takePhotoCooling(captureKey))
                    if (canPrompt) {
                        const text = `这张不能用：${problem}再拍一张，把题干、样例和数据范围都拍进去。`
                            + (repeated ? '上次也是这个原因，退后半步、把屏幕整个拍进来。' : '')
                        if (cfg.takePhotoEnabled === true) {
                            markTakePhoto(captureKey)
                            finishWithTakePhoto(text)
                        } else {
                            finish(text)
                        }
                        return
                    }
                    if (parsed.text.trim() === '') {
                        finish('这几张都拍不清楚，换个角度、靠近一点，或者把屏幕调亮后再拍一次。')
                        return
                    }
                    triageNote = mergeNote(triageNote, `照片没拍好（${problem}），按你描述的文字作答`)
                } else {
                    // Only usable photos join the solve set.
                    capture.images = [...capture.images, ...newRefs].slice(-cfg.imageMaxCaptures)
                    const soft = qualitySoftNote(worst)
                    if (soft !== '') triageNote = mergeNote(triageNote, soft)
                    if (cfg.imageTriageEnabled === true && !abort.signal.aborted) {
                        const precheckStarted = Date.now()
                        const verdict = await precheckImage({
                            imageBlocks,
                            text: parsed.text,
                            signal: abort.signal,
                            metrics: worst,
                        })
                        triageMs = Date.now() - precheckStarted
                        if (verdict === null) {
                            precheckSkipped = true
                        } else if (verdict.complete === false) {
                            const missing = verdict.missing.length > 0
                                ? verdict.missing.join('、')
                                : (verdict.reason || '关键内容')
                            log('info', `[PRECHECK] 题目不完整：缺 ${missing}（第 ${capture.captures} 张）`)
                            const repeated = capture.lastMissing === missing
                            capture.lastMissing = missing
                            const canPrompt = capture.captures < cfg.imageMaxCaptures
                                && (cfg.takePhotoEnabled !== true || !takePhotoCooling(captureKey))
                            if (canPrompt) {
                                const text = `题目不完整，缺：${missing}。请重拍：把题干、样例和数据范围一起拍进画面。`
                                    + (repeated ? '上次也是缺这里，退后半步、把整块屏幕都拍进来。' : '')
                                if (cfg.takePhotoEnabled === true) {
                                    markTakePhoto(captureKey)
                                    finishWithTakePhoto(text)
                                } else {
                                    finish(text)
                                }
                                return
                            }
                            if (parsed.text.trim() === '') {
                                finish(`题目不完整（缺：${missing}），先补拍一张完整的题目再问我。`)
                                return
                            }
                            triageNote = mergeNote(triageNote, `题目可能不全（缺 ${missing}），按现有照片作答`)
                        } else {
                            progress('（题目完整，正在解题）')
                        }
                    }
                }
            }

            // Solve with every photo collected in this capture session.
            const solveImages = capture !== null ? capture.images : newRefs
            const solveContent = parsed.content.filter((block) => block?.type !== 'image')
            if (solveImages.length > 1) {
                solveContent.unshift({
                    type: 'text',
                    text: `（这是同一道题的 ${solveImages.length} 张照片，可能有重叠，请合并理解。）`,
                })
            }
            for (const ref of solveImages) solveContent.push({ type: 'image', attachment: ref })

            const turnStarted = Date.now()
            const job = await enqueue(deviceId, (agentState) => runTurn(
                agentState,
                solveContent,
                selftestActive ? () => {} : (delta) => sendAnswer(delta, false),
                abort.signal,
            ))
            turnMs = Date.now() - turnStarted
            let answer = job.text.trim()
            if (answer === '') {
                finish(fallbackText(job))
                log('info', `[RESP] 200 /chat device=${deviceId} msg=${messageId} chars=0`
                    + ` total=${Date.now() - started}ms reason=${job.reason?.kind ?? '?'}`)
                return
            }
            if (selftestActive && extractCode(job.text) !== null && !abort.signal.aborted) {
                const debugHeader = String(req.headers['x-rokid-selftest-debug'] ?? '').trim().toLowerCase()
                const verifyStarted = Date.now()
                const verified = await verifier.verify({
                    answer: job.text,
                    requestText: parsed.text || '（用户只发了图片，请按画面里的题目作答）',
                    deviceId,
                    requestId: messageId,
                    signal: abort.signal,
                    onProgress: (phase) => progress(phase === 'compile'
                        ? '（代码已生成，正在编译验证）'
                        : '（还在验证中，正在继续修复）'),
                    ...(debugHeader === 'compile' || debugHeader === 'logic' ? { debugBreak: debugHeader } : {}),
                })
                answer = verified.answer.trim()
                verifyMs = Date.now() - verifyStarted
                if (verified.status === 'skipped') {
                    if (/compiler missing/u.test(String(verified.logLine || ''))) answer = `${answer}\n\n（本机没有可用的编译器，未做编译验证）`
                    else if (/#include|int\s+main\s*\(|```/u.test(answer)) answer = `${answer}\n\n（代码没能提取出来，未做编译验证）`
                }
                else if (verified.status === 'no-cases') answer = `${answer}\n\n（主机没有拿到可用测试用例，未做编译验证）`
                log('info', `${verified.logLine} device=${deviceId} msg=${messageId}`)
                void appendSelfTestLog(cfg.selftestLogPath,
                    `${verified.logLine} device=${deviceId} msg=${messageId} status=${verified.status}`)
            }
            if (triageNote !== '') answer = `（${triageNote}）\n\n${answer}`
            if (precheckSkipped) answer = `${answer}\n\n（未做完整性检查）`
            for (const piece of chunkText(answer)) sendAnswer(piece, false)
            finish(undefined)
            log('info', `[RESP] 200 /chat device=${deviceId} msg=${messageId} chars=${answer.length}`
                + ` first=${firstFrameAt ?? '-'}ms total=${Date.now() - started}ms reason=${job.reason?.kind ?? '?'}`
                + ` triage=${triageMs}ms turn=${turnMs}ms verify=${verifyMs}ms`)
        } catch (error) {
            log('error', `[RESP] 500 /chat msg=${messageId}: ${describeError(error)}`)
            finish(`[错误] ${describeError(error).slice(0, 200)}`)
        }
    }

    // ── Lingzhu payload → agent message content ──────────────────────────────
    async function parseLingzhuContent(body, req) {
        const items = Array.isArray(body?.message) ? body.message : undefined
        const blocks = []
        const texts = []
        const qualities = []
        let images = 0
        if (items !== undefined) {
            for (const item of items) {
                if (item === null || typeof item !== 'object') continue
                const role = String(item.role ?? 'user').trim().toLowerCase()
                if (role !== 'user') continue
                const type = String(item.type ?? '').trim().toLowerCase()
                const imageUrl = item.image_url ?? item.imageUrl ?? ''
                if (type === 'image' || (type === '' && imageUrl !== '')) {
                    const saved = await loadRemoteImage(imageUrl, req)
                    if (saved === null) {
                        blocks.push({ type: 'text', text: IMAGE_FAIL_TEXT })
                        texts.push(IMAGE_FAIL_TEXT)
                    } else {
                        blocks.push({ type: 'image', attachment: saved.ref })
                        qualities.push(saved.quality ?? null)
                        images += 1
                    }
                    continue
                }
                const text = typeof item.text === 'string' ? item.text : String(item.text ?? '')
                if (text.trim() === '') continue
                blocks.push({ type: 'text', text })
                texts.push(text)
            }
        }

        let legacy = false
        if (blocks.length === 0) {
            legacy = true
            const type = String(body?.type ?? 'text').trim().toLowerCase()
            const text = String(body?.text ?? '').trim()
            const image = body?.image
            if ((type === 'image' || type === 'text_with_image') && image !== null && typeof image === 'object'
                && typeof image.data === 'string' && image.data !== '') {
                const saved = await saveEncodedImage(image.data, image.mime_type)
                if (saved === null) {
                    blocks.push({ type: 'text', text: IMAGE_FAIL_TEXT })
                    texts.push(IMAGE_FAIL_TEXT)
                } else {
                    blocks.push({ type: 'text', text: text || IMAGE_ONLY_PROMPT })
                    blocks.push({ type: 'image', attachment: saved.ref })
                    qualities.push(saved.quality ?? null)
                    texts.push(text)
                    images += 1
                }
            } else if (text !== '') {
                blocks.push({ type: 'text', text })
                texts.push(text)
            }
        }

        const userText = texts.map((value) => value.trim()).filter((value) => value !== '').join('\n')
        const contextText = buildContextText(body?.metadata)
        const content = []
        if (contextText !== '') content.push({ type: 'text', text: contextText })
        for (const block of blocks) content.push(block)
        if (content.length === 0) return { content, text: '', images, legacy, qualities }
        if (content[0].type !== 'text') content.unshift({ type: 'text', text: userText || IMAGE_ONLY_PROMPT })
        return { content, text: userText, images, legacy, qualities }
    }

    // ── per-device warm agent session ────────────────────────────────────────
    function enqueue(deviceId, task) {
        const agentState = obtainDevice(deviceId)
        const run = () => task(agentState)
        const next = agentState.chain.then(run, run)
        agentState.chain = next.then(() => {}, () => {})
        return next
    }

    function obtainDevice(deviceId) {
        const existing = state.states.get(deviceId)
        if (existing !== undefined && existing.agent !== undefined) {
            existing.lastUsed = Date.now()
            return existing
        }
        if (existing !== undefined) state.states.delete(deviceId)
        if (state.states.size >= cfg.maxDevices) evictOldest()
        const agentState = {
            key: deviceId,
            agent: undefined,
            dispose: undefined,
            chain: Promise.resolve(),
            lastUsed: Date.now(),
            ready: undefined,
            current: undefined,
            lastAssistantText: '',
            sessionId: `rokid-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        }
        agentState.ready = createAgent(agentState).catch((error) => {
            log('error', `创建会话失败 device=${deviceId}: ${describeError(error)}`)
            agentState.ready = undefined
            throw error
        })
        state.states.set(deviceId, agentState)
        return agentState
    }

    async function createAgent(agentState) {
        const selection = ctx.agentDefaultModel.currentSelection()
        const effort = String(cfg.reasoningEffort || selection.reasoningEffort || '').trim()
        const agentOptions = { provider: selection.provider, model: selection.model }
        if (effort !== '') agentOptions.reasoningEffort = effort
        const presetId = await resolvePresetId()

        const meta = { cwd: state.workspace, origin: 'subagent' }
        if (presetId !== '') meta.agentPreset = presetId

        const handle = await ctx.agents.create({
            sessionId: agentState.sessionId,
            meta,
            agentOptions,
            setup: (agentCtx, agent) => {
                try {
                    agent.session.append('sandbox/mode', { mode: cfg.sandboxMode })
                    agent.session.append('approval/policy', { policy: 'never' })
                } catch (error) {
                    log('warn', `会话策略写入失败 device=${agentState.key}: ${describeError(error)}`)
                }
                agentCtx.on('agent/assistant-stream', (payload) => {
                    const frame = payload?.frame ?? payload
                    if (frame?.type !== 'chunk') return
                    const chunk = frame.chunk
                    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
                    const job = agentState.current
                    if (job === undefined) return
                    job.text += chunk.text
                    job.onDelta(chunk.text)
                })
                agentCtx.on('session/event', (session, event) => {
                    if (session?.id !== agent.session.id) return
                    if (event.type === 'assistant/message') {
                        const text = messageText(event.data?.message)
                        if (text !== '') agentState.lastAssistantText = text
                        return
                    }
                    if (event.type !== 'turn/end') return
                    const job = agentState.current
                    if (job === undefined) return
                    job.reason = event.data?.reason
                    job.resolveTurn()
                })
                agentCtx.on('agent/error', (payload) => {
                    if (payload?.agent?.id !== agent.session.id) return
                    log('warn', `会话报错 device=${agentState.key}: ${describeError(payload?.error)}`)
                })
            },
        })
        agentState.agent = handle.agent
        agentState.dispose = handle.dispose
        await handle.agent.whenIdle()
        log('info', `新会话 device=${agentState.key} session=${agentState.sessionId} `
            + `model=${agentOptions.provider}/${agentOptions.model}${effort === '' ? '' : ` effort=${effort}`}`
            + ` preset=${presetId === '' ? '-' : presetId}`)
    }

    async function resolvePresetId() {
        const configured = String(cfg.agentPreset || '').trim()
        if (configured !== '') return configured
        try {
            const presets = ctx.get('agentPresets')
            if (presets === undefined) return ''
            const current = await presets.resolve()
            const id = typeof current === 'string' ? current : current?.id
            return typeof id === 'string' ? id : ''
        } catch (error) {
            log('warn', `解析默认 agent preset 失败，改用部署组合：${describeError(error)}`)
            return ''
        }
    }

    async function runTurn(agentState, content, onDelta, signal) {
        if (agentState.agent === undefined && agentState.ready !== undefined) await agentState.ready
        const agent = agentState.agent
        if (agent === undefined) throw new Error('agent session unavailable')
        if (signal?.aborted) throw new Error('client closed the connection')

        const job = {
            text: '',
            reason: undefined,
            timedOut: false,
            onDelta: typeof onDelta === 'function' ? onDelta : () => {},
            resolveTurn: () => {},
        }
        const settled = new Promise((resolve) => {
            job.resolveTurn = resolve
        })

        const isFirstTurn = agentState.firstTurn !== true
        agentState.firstTurn = false
        const persona = isFirstTurn
            ? [state.systemPrompt, cfg.selftestEnabled === true ? String(cfg.selftestPersonaNote || '') : '']
                .map((part) => String(part || '').trim())
                .filter((part) => part !== '')
                .join('\n\n')
            : ''
        const message = makeUserMessage(composeContent(content, persona))

        agentState.current = job
        agentState.lastAssistantText = ''
        const timeoutMs = Math.max(5, cfg.turnTimeoutSeconds) * 1000
        const timer = setTimeout(() => {
            log('warn', `回合超时 device=${agentState.key}（${timeoutMs}ms），取消本轮`)
            job.timedOut = true
            cancelQuietly(agent, 'rokid-bridge timeout')
        }, timeoutMs)
        timer.unref?.()

        const onAbort = () => cancelQuietly(agent, 'client closed the connection')
        signal?.addEventListener('abort', onAbort, { once: true })

        try {
            agent.followup(message)
            await Promise.race([settled, agent.whenIdle()])
            await agent.whenIdle()
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            agentState.current = undefined
            agentState.lastUsed = Date.now()
        }
        if (job.text === '') job.text = agentState.lastAssistantText
        return job
    }

    function fallbackText(job) {
        if (job.timedOut) return '[错误] 这一轮想太久了，请再说一次'
        const kind = job.reason?.kind
        if (kind === 'error') {
            const code = job.reason?.error?.code ?? ''
            return code === '' ? '[错误] 模型暂时不可用，请稍后再试' : `[错误] 模型暂时不可用（${code}），请稍后再试`
        }
        if (kind === 'aborted') return '[错误] 这一轮被打断了，请再说一次'
        return '[错误] 没有拿到回答，请再说一次'
    }

    // ── image plumbing ───────────────────────────────────────────────────────
    async function loadRemoteImage(rawUrl, req) {
        const url = String(rawUrl ?? '').trim()
        if (url === '') return null
        if (url.toLowerCase().startsWith('data:')) return saveDataUrl(url, req)
        if (!isFetchableUrl(url)) {
            log('warn', `拒绝非 http(s) 或内网图片地址：${url.slice(0, 120)}`)
            return null
        }
        try {
            const signals = [AbortSignal.timeout(IMAGE_TIMEOUT_MS)]
            if (req?.signal) signals.push(req.signal)
            const response = await fetch(url, {
                headers: { 'user-agent': 'rokid-bridge-dsh/0.2' },
                redirect: 'follow',
                signal: AbortSignal.any(signals),
            })
            if (!response.ok) {
                log('warn', `图片下载失败 HTTP ${response.status}: ${url.slice(0, 120)}`)
                return null
            }
            const declared = Number(response.headers.get('content-length') ?? 0)
            if (declared > IMAGE_MAX_BYTES) {
                log('warn', `图片超过 ${IMAGE_MAX_BYTES} 字节（声明 ${declared}），放弃`)
                return null
            }
            const bytes = new Uint8Array(await response.arrayBuffer())
            log('info', `[IMAGE] fetch ${url.slice(0, 140)} status=${response.status}`
                + ` ct=${response.headers.get('content-type') ?? '-'} bytes=${bytes.byteLength}`)
            return saveBytes(bytes, undefined)
        } catch (error) {
            log('warn', `图片下载异常 ${url.slice(0, 120)}: ${describeError(error)}`)
            return null
        }
    }

    async function saveDataUrl(url, req) {
        const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/iu.exec(url)
        if (match === null || match[2] !== ';base64') {
            log('warn', 'data URL 不是 base64 编码，放弃')
            return null
        }
        try {
            return await saveBytes(new Uint8Array(Buffer.from(match[3], 'base64')), match[1])
        } catch (error) {
            log('warn', `data URL 解析失败: ${describeError(error)}`)
            return null
        }
    }

    async function saveEncodedImage(base64, mimeType) {
        try {
            return await saveBytes(new Uint8Array(Buffer.from(String(base64), 'base64')), mimeType)
        } catch (error) {
            log('warn', `image.data 解码失败: ${describeError(error)}`)
            return null
        }
    }

    async function saveBytes(bytes, declaredMime) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null
        if (bytes.byteLength > IMAGE_MAX_BYTES) {
            log('warn', `图片有 ${bytes.byteLength} 字节，超过 ${IMAGE_MAX_BYTES}，放弃`)
            return null
        }
        const limits = ctx.attachments.imageLimits
        const mediaType = sniffMediaType(bytes)
        if (mediaType === undefined || !limits.mediaTypes.includes(mediaType)) {
            log('warn', `识别不出图片格式（声明 ${declaredMime ?? '-'}），放弃`)
            return null
        }
        try {
            const refs = await ctx.attachments.saveImages([{ data: bytes, mediaType, name: 'rokid-glasses' }])
            const quality = await measureImageQuality(bytes)
            if (quality !== null) {
                quality.savedWidth = refs[0].width
                quality.savedHeight = refs[0].height
                try {
                    const selection = ctx.agentDefaultModel.currentSelection()
                    const target = ctx.llm.imageRequestTarget(selection.provider, selection.model, refs[0])
                    quality.apiWidth = target.width
                    quality.apiHeight = target.height
                    quality.apiMaxBytes = target.maxBytes
                } catch {
                    // route may not declare image pricing; leave the api fields unset
                }
            }
            return { ref: refs[0], quality }
        } catch (error) {
            const code = ctx.attachments.isAttachmentError?.(error) === true ? error.code : undefined
            log('warn', `图片入库失败${code === undefined ? '' : ` (${code})`}: ${describeError(error)}`)
            return null
        }
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    async function reapIdle() {
        const deadline = Date.now() - Math.max(1, cfg.idleMinutes) * 60_000
        for (const [key, agentState] of [...state.states]) {
            if (agentState.current !== undefined || agentState.lastUsed > deadline) continue
            state.states.delete(key)
            log('info', `回收空闲会话 device=${key} session=${agentState.sessionId}`)
            try {
                agentState.agent?.cancel({ kind: 'disposed' })
            } catch {
                // ignore
            }
            try {
                await agentState.dispose?.()
            } catch (error) {
                log('warn', `会话销毁失败 device=${key}: ${describeError(error)}`)
            }
        }
    }

    function evictOldest() {
        let oldestKey
        let oldestAt = Infinity
        for (const [key, agentState] of state.states) {
            if (agentState.current !== undefined) continue
            if (agentState.lastUsed < oldestAt) {
                oldestAt = agentState.lastUsed
                oldestKey = key
            }
        }
        if (oldestKey === undefined) return
        const victim = state.states.get(oldestKey)
        state.states.delete(oldestKey)
        log('info', `会话数达上限，回收 device=${oldestKey}`)
        cancelQuietly(victim.agent, 'evicted')
        void victim.dispose?.().catch(() => {})
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizeConfig(raw) {
    const cfg = { ...DEFAULTS }
    if (raw === null || typeof raw !== 'object') return cfg
    for (const [key, value] of Object.entries(raw)) {
        if (value === undefined) continue
        cfg[key] = value
    }
    cfg.host = String(cfg.host || DEFAULTS.host).trim() || DEFAULTS.host
    cfg.port = toInteger(cfg.port, DEFAULTS.port, 1, 65_535)
    cfg.idleMinutes = toInteger(cfg.idleMinutes, DEFAULTS.idleMinutes, 1, 24 * 60)
    cfg.maxDevices = toInteger(cfg.maxDevices, DEFAULTS.maxDevices, 1, 64)
    cfg.maxConcurrent = toInteger(cfg.maxConcurrent, DEFAULTS.maxConcurrent, 1, 32)
    cfg.turnTimeoutSeconds = toInteger(cfg.turnTimeoutSeconds, DEFAULTS.turnTimeoutSeconds, 5, 600)
    cfg.heartbeatSeconds = toInteger(cfg.heartbeatSeconds, DEFAULTS.heartbeatSeconds, 1, 120)
    cfg.selftestMaxAttempts = toInteger(cfg.selftestMaxAttempts, DEFAULTS.selftestMaxAttempts, 0, 200)
    cfg.selftestMaxCaseFailures = toInteger(cfg.selftestMaxCaseFailures, DEFAULTS.selftestMaxCaseFailures, 1, 20)
    cfg.selftestRepeatLimit = toInteger(cfg.selftestRepeatLimit, DEFAULTS.selftestRepeatLimit, 1, 20)
    cfg.selftestEscalations = toInteger(cfg.selftestEscalations, DEFAULTS.selftestEscalations, 0, 10)
    cfg.selftestCompileTimeoutMs = toInteger(cfg.selftestCompileTimeoutMs, DEFAULTS.selftestCompileTimeoutMs, 1_000, 60_000)
    cfg.selftestCaseTimeoutMs = toInteger(cfg.selftestCaseTimeoutMs, DEFAULTS.selftestCaseTimeoutMs, 500, 30_000)
    cfg.selftestBudgetSeconds = toInteger(cfg.selftestBudgetSeconds, DEFAULTS.selftestBudgetSeconds, 0, 3_600)
    cfg.requestWatchdogSeconds = toInteger(cfg.requestWatchdogSeconds, DEFAULTS.requestWatchdogSeconds, 0, 3_600)
    cfg.selftestProgressSeconds = toInteger(cfg.selftestProgressSeconds, DEFAULTS.selftestProgressSeconds, 5, 300)
    cfg.selftestProgressMaxFrames = toInteger(cfg.selftestProgressMaxFrames, DEFAULTS.selftestProgressMaxFrames, 0, 50)
    cfg.selftestEnabled = cfg.selftestEnabled === true || cfg.selftestEnabled === 'true'
    cfg.takeOverLegacyPort = cfg.takeOverLegacyPort === true || cfg.takeOverLegacyPort === 'true'
    cfg.imageTriageEnabled = cfg.imageTriageEnabled === true || cfg.imageTriageEnabled === 'true'
    cfg.imageTriageTimeoutSeconds = toInteger(cfg.imageTriageTimeoutSeconds, DEFAULTS.imageTriageTimeoutSeconds, 5, 120)
    cfg.imageQualityGateEnabled = cfg.imageQualityGateEnabled === true || cfg.imageQualityGateEnabled === 'true'
    cfg.imageMinSharpness = toInteger(cfg.imageMinSharpness, DEFAULTS.imageMinSharpness, 1, 10_000)
    cfg.imageSoftSharpness = toInteger(cfg.imageSoftSharpness, DEFAULTS.imageSoftSharpness, 1, 10_000)
    cfg.imageMinBrightness = toInteger(cfg.imageMinBrightness, DEFAULTS.imageMinBrightness, 1, 255)
    cfg.imageMinLongEdge = toInteger(cfg.imageMinLongEdge, DEFAULTS.imageMinLongEdge, 100, 10_000)
    cfg.takePhotoEnabled = cfg.takePhotoEnabled === true || cfg.takePhotoEnabled === 'true'
    cfg.takePhotoCooldownSeconds = toInteger(cfg.takePhotoCooldownSeconds, DEFAULTS.takePhotoCooldownSeconds, 5, 600)
    cfg.imageMaxCaptures = toInteger(cfg.imageMaxCaptures, DEFAULTS.imageMaxCaptures, 1, 5)
    cfg.captureTtlMinutes = toInteger(cfg.captureTtlMinutes, DEFAULTS.captureTtlMinutes, 1, 60)
    cfg.imageMinShortEdge = toInteger(cfg.imageMinShortEdge, DEFAULTS.imageMinShortEdge, 100, 10_000)
    cfg.imageIgnoreShortEdge = toInteger(cfg.imageIgnoreShortEdge, DEFAULTS.imageIgnoreShortEdge, 0, 10_000)
    cfg.selftestForAsk = cfg.selftestForAsk === true || cfg.selftestForAsk === 'true'
    cfg.selftestKeepWorkDir = cfg.selftestKeepWorkDir === true || cfg.selftestKeepWorkDir === 'true'
    if (!['off', 'compile', 'logic'].includes(String(cfg.selftestDebugBreak).trim())) cfg.selftestDebugBreak = 'off'
    if (!SANDBOX_MODES.has(String(cfg.sandboxMode).trim())) cfg.sandboxMode = DEFAULTS.sandboxMode
    for (const key of ['accessKey', 'legacyConfigPath', 'logPath', 'systemPrompt', 'workspace', 'agentPreset', 'reasoningEffort',
        'selftestLogPath', 'selftestWorkDir', 'selftestWslDistro', 'selftestAckText', 'selftestPersonaNote', 'imageAckText']) {
        cfg[key] = typeof cfg[key] === 'string' ? cfg[key] : String(cfg[key] ?? '')
    }
    return cfg
}

function toInteger(value, fallback, min, max) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
}

function readLegacyConfig(path) {
    const result = { used: false, rokidAk: '', systemPrompt: '' }
    if (typeof path !== 'string' || path.trim() === '') return result
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
        if (parsed === null || typeof parsed !== 'object') return result
        if (typeof parsed.rokid_ak === 'string') result.rokidAk = parsed.rokid_ak
        if (typeof parsed.system_prompt === 'string') result.systemPrompt = parsed.system_prompt
        result.used = result.rokidAk !== '' || result.systemPrompt !== ''
    } catch {
        // An absent legacy config is normal; config fields take over.
    }
    return result
}

function buildContextText(metadata) {
    const context = metadata?.context
    if (context === null || typeof context !== 'object') return ''
    const parts = []
    const seen = new Set()
    const append = (key, label) => {
        const value = context[key]
        if (value === null || value === undefined || value === '') return
        if (typeof value === 'object' && Object.keys(value).length === 0) return
        parts.push(`${label}：${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
    for (const [key, label] of [['location', '位置'], ['weather', '天气'], ['battery', '电量'], ['current_time', '时间']]) {
        seen.add(key)
        append(key, label)
    }
    for (const key of Object.keys(context)) {
        if (seen.has(key)) continue
        append(key, key)
    }
    if (parts.length === 0) return ''
    return `用户当前环境（仅供参考，不必逐条复述）：${parts.join('；')}`
}

function composeContent(content, personaText) {
    const out = []
    if (typeof personaText === 'string' && personaText.trim() !== '') {
        out.push({ type: 'text', text: personaText.trim() })
    }
    for (const block of content) out.push(block)
    return out
}

function makeUserMessage(content) {
    if (typeof createUserMessage === 'function') {
        return createUserMessage({ content, source: { kind: 'user' } })
    }
    return { id: randomUUID(), role: 'user', content, source: { kind: 'user' } }
}

function messageText(message) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
    return message.content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
        .trim()
}

/** Split a finished answer into SSE-sized pieces so the glasses still renders progressively. */
function chunkText(text, size = 180) {
    const value = String(text ?? '')
    if (value.length <= size) return value === '' ? [] : [value]
    const pieces = []
    for (let index = 0; index < value.length; index += size) pieces.push(value.slice(index, index + size))
    return pieces
}

function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
    })
}

function clipText(text, limit = 200) {
    const value = String(text ?? '')
    return value.length <= limit ? value : `${value.slice(0, limit)}…（已截断）`
}

function withTimeout(signal, timeoutMs) {
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    if (signal === undefined || signal === null) return timeout
    if (timeout === undefined) return signal
    return AbortSignal.any([signal, timeout])
}

function parseJsonObject(text) {
    const value = String(text ?? '')
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
        return JSON.parse(value.slice(start, end + 1))
    } catch {
        return null
    }
}

function mergeNote(current, extra) {
    const first = String(current ?? '').trim()
    const second = String(extra ?? '').trim()
    if (second === '') return first
    return first === '' ? second : `${first}；${second}`
}

/** Run one Windows PowerShell command; resolves even on failure. */
function runPowerShell(script, timeoutMs = 10_000) {
    return new Promise((resolve) => {
        let settled = false
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
        const out = []
        const err = []
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try {
                child.kill()
            } catch {
                // ignore
            }
            resolve({ code: -1, stdout: '', stderr: 'timeout' })
        }, timeoutMs)
        timer.unref?.()
        child.stdout.on('data', (chunk) => out.push(chunk))
        child.stderr.on('data', (chunk) => err.push(chunk))
        child.on('error', () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ code: -1, stdout: '', stderr: 'spawn failed' })
        })
        child.on('close', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
        })
    })
}

/** Find the process listening on one loopback port (Windows only). */
async function findPortOwner(port) {
    const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
        + `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;`
        + 'if ($null -eq $c) { "NONE" } else {'
        + ' $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)";'
        + ' $n = if ($p) { $p.Name } else { (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName };'
        + ' "$($c.OwningProcess)|$n|$($p.CommandLine)" }'
    const result = await runPowerShell(script)
    const lines = String(result.stdout || '').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
    const last = lines.length > 0 ? lines[lines.length - 1] : 'NONE'
    if (last === 'NONE') return null
    const first = last.indexOf('|')
    if (first < 0) return null
    const second = last.indexOf('|', first + 1)
    const pid = Number(last.slice(0, first))
    if (!Number.isFinite(pid) || pid <= 0) return null
    const name = second < 0 ? '' : last.slice(first + 1, second)
    const commandLine = second < 0 ? '' : last.slice(second + 1)
    return { pid, name, commandLine }
}

function cancelQuietly(agent, reason) {
    try {
        agent?.cancel({ kind: 'hook', reason })
    } catch {
        // cancellation is best-effort
    }
}

function sniffMediaType(bytes) {
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
    return undefined
}

function isFetchableUrl(raw) {
    let parsed
    try {
        parsed = new URL(raw)
    } catch {
        return false
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return false
    if (host === '::1' || host === '0.0.0.0') return false
    if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./u.test(host)) return false
    return true
}

function readJsonBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        let settled = false
        req.on('data', (chunk) => {
            if (settled) return
            size += chunk.length
            if (size > limit) {
                settled = true
                const error = new Error('payload too large')
                error.status = 413
                reject(error)
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            if (settled) return
            settled = true
            if (size === 0) {
                resolve({})
                return
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (error) {
                const wrapped = new Error(`bad json: ${describeError(error)}`)
                wrapped.status = 400
                reject(wrapped)
            }
        })
        req.on('error', (error) => {
            if (settled) return
            settled = true
            reject(error)
        })
    })
}

/**
 * Read a raw binary body (image bytes, not JSON). Rejects with `status = 413` once
 * `limit` is exceeded; the remainder of the upload is drained (up to 3x the limit)
 * so the client can still read the 413 response instead of a bare TCP reset.
 */
function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        let settled = false
        req.on('data', (chunk) => {
            size += chunk.length
            if (settled) {
                if (size > limit * 3) {
                    try {
                        req.destroy()
                    } catch {
                        // already gone
                    }
                }
                return
            }
            if (size > limit) {
                settled = true
                const error = new Error('image too large')
                error.status = 413
                error.bytes = size
                reject(error)
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            if (settled) return
            settled = true
            resolve(Buffer.concat(chunks))
        })
        req.on('error', (error) => {
            if (settled) return
            settled = true
            reject(error)
        })
    })
}

/** Discard an unwanted upload so the already-sent status line still reaches the client. */
function drainRequest(req, capBytes) {
    let seen = 0
    req.on('data', (chunk) => {
        seen += chunk.length
        if (seen > capBytes) {
            try {
                req.destroy()
            } catch {
                // already gone
            }
        }
    })
    req.resume()
}

function sendJson(res, status, value) {
    if (res.writableEnded || res.headersSent) return
    const text = JSON.stringify(value)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
    })
    res.end(text)
}

function describeError(error) {
    if (error === null || error === undefined) return 'unknown error'
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
}
