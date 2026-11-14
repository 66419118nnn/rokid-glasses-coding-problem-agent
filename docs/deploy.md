# Deployment

Two sides: the AIUI agent on the glasses (`client/`) and the bridge on the host (`server/`). Each side can be debugged alone, but the full path needs both.

---

## A. Glasses side (`client/`)

### 1. Fill in the config

Edit `client/config.js`:

```js
export const BRIDGE_URL = 'https://<your-domain>/rokid/ask-raw';
export const BRIDGE_AK = '<same value as server accessKey>';
export const QUESTION = '这是一道编程题的照片，请按系统提示解答。';
```

### 2. Import into AIUI Studio

1. Open <https://aiui.rokid.com> and sign in with your Rokid account
2. New agent → **Local import** → select the `client/` folder (it must contain `app.json`)
3. Open the project → **Device debug** → fill the intent description, e.g.:
   `When the user asks about a problem, photograph it and give the approach plus C++ code`
4. Click **Repack and save** and wait for the status to become "synced" and the green "debug version ready" banner

### 3. Push to the glasses

1. Rokid AI app → Settings → Developer → **Update glasses resource pack**, wait for "resource pack downloaded"
2. On the glasses, say: **"open <your-agent>"**
3. Aim at the problem and **single-click the temple**

> `.aix/agent-id` inside `client/` is generated on import; do not reuse it across accounts. It is gitignored.

### 4. Acceptance

- The viewfinder appears (640×480 low-bitrate preview)
- After capture the status line shows `source: default 3024×4032 luma XX`
- Swiping up/down pages the answer and does **not** trigger a capture
- While waiting, the status line refreshes every 10 s: "host is still thinking, waited N s"

---

## B. Host side (`server/`)

### 1. Dependencies

- Node.js 20+ (DSH's bundled runtime is fine)
- DSH (DeepSeek Harness); the plugin injects `agents` / `agentDefaultModel` / `attachments` / `llm`
- Windows + WSL with `wsl g++ --version` working (`apt install build-essential` on Ubuntu)

### 2. Install the plugin

Put `server/` into the DSH local plugin directory (e.g. `~/.dsh/local-plugins/rokid-bridge-dsh`) and link it in the profile's `package.json`:

```json
"dependencies": { "rokid-bridge-dsh": "link:C:/path/to/rokid-bridge-dsh" }
```

Insert the plugin config in the profile's `cordis.patch.yml` (note: a later patch with the same id replaces `config`, so write all fields at once):

```yaml
- insert:
    - id: rokid-bridge-dsh
      name: 'rokid-bridge-dsh'
      config:
        port: 8091
        accessKey: '<YOUR_ACCESS_KEY>'
        selftestForAsk: true
        reasoningEffort: max
        selftestEscalations: 2
        selftestBudgetSeconds: 540
        turnTimeoutSeconds: 240
        selftestWslDistro: ''        # empty = default WSL distro
```

Reload DSH and check:

```bash
curl http://127.0.0.1:8091/health
# {"status":"ok","service":"rokid-bridge"}
```

### 3. Public entry

The bridge only listens on loopback; expose it with a reverse proxy or tunnel.

**Caddy (recommended, automatic HTTPS)**

```caddyfile
<your-domain> {
    handle_path /rokid/* {
        reverse_proxy 127.0.0.1:8091 {
            flush_interval -1
        }
    }
}
```

> `flush_interval -1` is required for the `/chat` SSE stream; `/ask-raw` is plain JSON and unaffected.
> If Caddy runs with `admin off`, use `systemctl restart caddy` after edits; `reload` has no effect.

**Cloudflare Tunnel (no public IP)**

```bash
cloudflared tunnel --url http://127.0.0.1:8091
```

Use the generated `https://xxx.trycloudflare.com` in `client/config.js` (`BRIDGE_URL`, path `/ask-raw`).

### 4. Reverse SSH tunnel (optional)

If the host is behind NAT, let it open `ssh -R 127.0.0.1:8091:127.0.0.1:8091` to a jump host with a public IP, then reverse-proxy from that host's Caddy. Bind the jump host's loopback only; never `0.0.0.0`.

---

## C. Acceptance checklist

| Item | Command / action | Expected |
|---|---|---|
| Health | `curl <base>/health` | `{"status":"ok"}` |
| Auth | `/ask-raw` without AK | `401` |
| Text | `POST /ask` text only | `200` + answer |
| Image | `POST /ask-raw` with a problem photo | `200`, text readable from the image |
| Selftest | log shows `[SELFTEST] compile=ok cases=N/N` | answer ends with "passed compile and N test cases" |
| Glasses | single-click temple | answer on screen; status line shows source/pixels/luma |

---

## D. Troubleshooting

| Symptom | What to check |
|---|---|
| Glasses show "phone disconnected" | Usually an oversized preview stream overloading the runtime; make sure the preview is 640×480, not 4K |
| Photos come out black | Check `takePhoto` mode; the app falls back `default → wide → telephoto`, and the status line shows the actual mode and luma |
| Glasses request times out | Glasses fetch timeout 600 s, selftest budget 540 s; raising both is fine, but keep "budget + model generation < client timeout" |
| Answer says a case failed | Compile passed; the generated expected value is suspicious (`suspect-case=1`). Not a compile failure |
| Public 502 | Check the tunnel, the reverse proxy target (8091), and `/health` |
| Garbled logs | Logs are UTF-8; on Windows use `Get-Content -Encoding UTF8 -Tail 60` |