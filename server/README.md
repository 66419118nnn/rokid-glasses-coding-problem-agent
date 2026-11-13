# rokid-bridge-dsh

**English** | [简体中文](README.zh-CN.md)

A DSH (DeepSeek Harness) Host plugin that exposes HTTP endpoints for Rokid Glasses AIUI agents and Lingzhu custom agents:

| Method | Path | Purpose |
|---|---|---|
| POST | `/ask-raw`, `/rokid/ask-raw` | Raw image bytes + `?q=` question → `{"answer": "..."}` (AIUI direct) |
| POST | `/ask`, `/rokid/ask` | JSON `{text,image:{data,mime_type}}` → `{"answer": "..."}` |
| POST | `/chat`, `/rokid/chat` | Lingzhu named-event SSE (`event:message` / `event:done`) |
| GET | `/health`, `/` | Health check |

All endpoints share one answer pipeline: DSH agent session → model → (when the answer contains C++) host-side `g++` compile + test cases → final answer.

## Requirements

- DSH (the plugin injects `agents` / `agentDefaultModel` / `attachments` / `llm`)
- Node.js 20+
- Windows + WSL (Linux `g++` for the self-test; `build-essential` recommended)
- Optional: Caddy / reverse tunnel to expose `127.0.0.1:<port>` as public HTTPS

## Install

Put this directory into the DSH profile as a local plugin (e.g. `~/.dsh/local-plugins/rokid-bridge-dsh`), link it in the profile's `package.json`, and insert a config row in `cordis.patch.yml`:

```yaml
- insert:
    - id: rokid-bridge-dsh
      name: 'rokid-bridge-dsh'
      config:
        port: 8091          # 8090 in production is fine too
        accessKey: '<YOUR_ACCESS_KEY>'
        selftestForAsk: true
        reasoningEffort: max
```

Reload DSH; `curl http://127.0.0.1:8091/health` should return:

```json
{"status":"ok","service":"rokid-bridge"}
```

## Key configuration

| Field | Default | Description |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8091` | Listen address; loopback only, public entry is a reverse proxy |
| `accessKey` | empty | Bearer AK; empty falls back to `rokid_ak` in `legacyConfigPath` |
| `reasoningEffort` | empty | Override reasoning effort (e.g. `max`); empty uses the DSH session setting |
| `selftestEnabled` | `true` | Compile + run cases when the answer contains C++ |
| `selftestForAsk` | `false` | Also run the self-test for `/ask` and `/ask-raw` |
| `selftestEscalations` | `1` | Agent deep-debug rounds after mechanical rewrites stall |
| `selftestBudgetSeconds` | `170` | Self-test watchdog; returns the last version with a note at the cap |
| `turnTimeoutSeconds` | `90` | Per-turn timeout |
| `imageMinSharpness` etc. | see `index.js` | `/chat` image quality gates |

See `DEFAULTS` and the Config Schema at the top of `index.js` for the full list.

## What the self-test does

When the model output contains C++ code, the plugin:

1. Extracts the code into a temporary `main.cpp`
2. Compiles with `wsl g++ -std=c++17 -O2 -Wall`
3. Generates 3 test cases and runs them one by one
4. Feeds compile stderr or "input/expected/actual" back to the model for a rewrite
5. Returns only the final version, ending with "passed compile and N test cases"

Logs: `[SELFTEST]` lines go to `selftestLogPath` (default `<home>/rokid-bridge/selftest.log`).

## Security

- Listen on `127.0.0.1` only; never expose the port directly to the internet
- Do not hardcode `accessKey` in the repo; use DSH config or environment variables
- Put HTTPS and source restrictions in front of the public entry (security group, Cloudflare Tunnel, Caddy)
- Image ingest is capped at 12 MB; the storage pipeline caps at 8 MB

## License

MIT