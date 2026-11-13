# Protocol

**English** | [简体中文](protocol.zh-CN.md)

All endpoints share one answer pipeline; only the request shape and response format differ. Default listen address: `127.0.0.1:8091` (change with `port`).

Auth: except `GET /health`, every request must carry:

```
Authorization: Bearer <ACCESS_KEY>
```

Units: milliseconds. Image limits: `/ask-raw` ingest 12 MB; the storage pipeline has a separate 8 MB cap.

---

## 1. `POST /ask-raw` (glasses AIUI direct)

The raw image bytes are the request body; no base64.

```
POST /ask-raw?q=<URL-encoded question>
Authorization: Bearer <ACCESS_KEY>
Content-Type: image/jpeg | image/webp | image/png
Body: <raw image bytes>
```

Response:

```json
{"answer":"...final answer; C++ answers end with \"passed compile and N test cases\"..."}
```

Example:

```bash
curl -X POST "https://<your-domain>/rokid/ask-raw?q=%E8%BF%99%E6%98%AF%E4%B8%80%E9%81%93%E7%BC%96%E7%A8%8B%E9%A2%98%E7%9A%84%E7%85%A7%E7%89%87" \
  -H "Authorization: Bearer <ACCESS_KEY>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @problem.jpg
```

Notes:

- `q` defaults to "这是一道编程题的照片，请按系统提示解答。"
- Alias: `/rokid/ask-raw`
- Optional `?device_id=` (or `user_id`) reuses a session; defaults to `glasses`
- Status codes: `401` unauthorized, `405` wrong method, `413` over 12 MB, `400` empty image, `502` upstream failure

---

## 2. `POST /ask` (JSON + base64)

```json
{
  "device_id": "glasses",
  "text": "how do I solve this",
  "image": { "data": "<base64>", "mime_type": "image/jpeg" }
}
```

Response is the same as `/ask-raw`. At least one of `text` or `image` is required; otherwise `422`.

---

## 3. `POST /chat` (Lingzhu custom-agent SSE)

Request (Lingzhu pushes this to the server):

```json
{
  "message_id": "1794559193700",
  "agent_id": "cad4529937694bd6b3ab60e276d47c1b",
  "user_id": "6F85...3D0F",
  "third_agent_id": "rokid-bridge-01",
  "metadata": { "context": { "location": "...", "weather": "...", "battery": "100 (Charging)" } },
  "message": [
    { "role": "user", "type": "image", "image_url": "https://.../temp/xxx.webp" },
    { "role": "user", "type": "text", "text": "look at this problem" }
  ]
}
```

The response must be **named-event SSE**, with no space after the colon:

```
event:message
data:{"role":"agent","type":"answer","answer_stream":"first chunk","message_id":"1794559193700","agent_id":"cad4529937694bd6b3ab60e276d47c1b","is_finish":false}

event:message
data:{"role":"agent","type":"answer","answer_stream":"second chunk","message_id":"1794559193700","agent_id":"cad4529937694bd6b3ab60e276d47c1b","is_finish":true}

event:done
data:[DONE]
```

Conventions:

- Send the first `event:message` within ~1 second (status frame) so Lingzhu does not time out
- During long work, write a `: heartbeat` comment line every 8–10 seconds (SSE comments keep the connection alive; Lingzhu ignores the content)
- Send `is_finish:true` only once, in the final frame; always follow it with `event:done`
- Images arrive as temporary URLs; the server downloads and base64-encodes them (SSRF guards included)
- `metadata.context` (location/weather/battery) is appended to the system prompt

---

## 4. `GET /health`

```json
{"status":"ok","service":"rokid-bridge"}
```

No auth; suitable for tunnel/reverse-proxy health checks.