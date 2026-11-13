# rokid-bridge-dsh

[English](README.md) | **简体中文**

一个跑在 DSH（DeepSeek Harness）里的 Host 插件，为 Rokid 眼镜的 AIUI 智能体和灵珠自定义智能体提供 HTTP 入口：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/ask-raw`、`/rokid/ask-raw` | 原始图片字节 + `?q=` 问题 → `{"answer": "..."}`（眼镜 AIUI 直连） |
| POST | `/ask`、`/rokid/ask` | JSON `{text,image:{data,mime_type}}` → `{"answer": "..."}` |
| POST | `/chat`、`/rokid/chat` | 灵珠命名事件 SSE（`event:message` / `event:done`） |
| GET | `/health`、`/` | 健康检查 |

所有入口共用同一条回答链路：DSH agent 会话 → 模型 →（含 C++ 代码时）主机侧 `g++` 真编译 + 跑用例 → 返回最终版。

## 依赖

- DSH（插件通过 `agents` / `agentDefaultModel` / `attachments` / `llm` 注入）
- Node.js 20+
- Windows + WSL（自检编译用 Linux `g++`，建议 `build-essential`）
- 可选：Caddy / 反向隧道，把 `127.0.0.1:<port>` 暴露成公网 HTTPS

## 安装

把本目录作为本地插件放进 DSH profile（例如 `~/.dsh/local-plugins/rokid-bridge-dsh`），在 profile 的 `package.json` 里 link 它，并在 `cordis.patch.yml` 里插入一行配置：

```yaml
- insert:
    - id: rokid-bridge-dsh
      name: 'rokid-bridge-dsh'
      config:
        port: 8091          # 生产可改成 8090
        accessKey: '<YOUR_ACCESS_KEY>'
        selftestForAsk: true
        reasoningEffort: max
```

重启 / 重载 DSH 后，`curl http://127.0.0.1:8091/health` 应返回：

```json
{"status":"ok","service":"rokid-bridge"}
```

## 关键配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8091` | 监听地址；只绑回环，公网交给反代 |
| `accessKey` | 空 | Bearer AK；留空则回退读 `legacyConfigPath` 的 `rokid_ak` |
| `reasoningEffort` | 空 | 覆盖思考强度（如 `max`）；留空沿用 DSH 当前档位 |
| `selftestEnabled` | `true` | 回答含 C++ 时是否编译 + 跑用例 |
| `selftestForAsk` | `false` | `/ask` 与 `/ask-raw` 是否也走自检 |
| `selftestEscalations` | `1` | 机械重写卡住后转 agent 深度调试的次数 |
| `selftestBudgetSeconds` | `170` | 自检看门狗；到点返回最后一版并标注未通过 |
| `turnTimeoutSeconds` | `90` | 单回合超时 |
| `imageMinSharpness` 等 | 见 `index.js` | `/chat` 的图片质量闸 |

完整字段见 `index.js` 顶部的 `DEFAULTS` 与 Config Schema。

## 自检是什么

模型输出里出现 C++ 代码时，插件会：

1. 抽取代码写入临时 `main.cpp`
2. `wsl g++ -std=c++17 -O2 -Wall` 编译
3. 生成 3 组用例，逐组运行并比对输出
4. 编译/用例失败就把 stderr 或“输入/期望/实际”回灌给模型重写
5. 通过后只输出最终版，并在末尾注明「已通过编译与 N 组用例」

日志：`[SELFTEST]` 行写入 `selftestLogPath`（默认 `<home>/rokid-bridge/selftest.log`）。

## 安全

- 只监听 `127.0.0.1`，不要直接把端口暴露到公网
- `accessKey` 不要硬编码进仓库；用 DSH 配置或环境变量
- 公网入口请加 HTTPS，并限制来源（安全组、Cloudflare Tunnel、Caddy 均可）
- 图片入口限制 12MB；入库另有 8MB 上限

## License

MIT
