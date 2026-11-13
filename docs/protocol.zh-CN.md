# 接口协议

[English](protocol.md) | **简体中文**

所有入口共用一条回答链路；区别只在入参形态和出参格式。默认监听 `127.0.0.1:8091`（可通过 `port` 改）。

鉴权：除 `GET /health` 外，所有请求需带

```
Authorization: Bearer <ACCESS_KEY>
```

时间单位：毫秒。图片上限：`/ask-raw` 摄入 12 MB，入库管线另有 8 MB。

---

## 1. `POST /ask-raw`（眼镜 AIUI 直连）

原始图片字节直接作为 body，不做 base64。

```
POST /ask-raw?q=<URL 编码的问题>
Authorization: Bearer <ACCESS_KEY>
Content-Type: image/jpeg | image/webp | image/png
Body: <原始图片字节>
```

响应：

```json
{"answer":"...最终答案，C++ 题会在末尾注明「已通过编译与 N 组用例」..."}
```

示例：

```bash
curl -X POST "https://<your-domain>/rokid/ask-raw?q=%E8%BF%99%E6%98%AF%E4%B8%80%E9%81%93%E7%BC%96%E7%A8%8B%E9%A2%98%E7%9A%84%E7%85%A7%E7%89%87" \
  -H "Authorization: Bearer <ACCESS_KEY>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @problem.jpg
```

说明：

- `q` 缺省为「这是一道编程题的照片，请按系统提示解答。」
- 别名：`/rokid/ask-raw`
- `?device_id=`（或 `user_id`）可选，用于复用会话；缺省 `glasses`
- 错误码：`401` 未授权、`405` 方法不对、`413` 超过 12 MB、`400` 空图、`502` 上游失败

---

## 2. `POST /ask`（JSON + base64）

```json
{
  "device_id": "glasses",
  "text": "这题怎么做",
  "image": { "data": "<base64>", "mime_type": "image/jpeg" }
}
```

响应同 `/ask-raw`。`text` 与 `image` 至少有一个，否则 `422`。

---

## 3. `POST /chat`（灵珠自定义智能体 SSE）

请求（灵珠推给服务端）：

```json
{
  "message_id": "1794559193700",
  "agent_id": "cad4529937694bd6b3ab60e276d47c1b",
  "user_id": "6F85...3D0F",
  "third_agent_id": "rokid-bridge-01",
  "metadata": { "context": { "location": "...", "weather": "...", "battery": "100 (Charging)" } },
  "message": [
    { "role": "user", "type": "image", "image_url": "https://.../temp/xxx.webp" },
    { "role": "user", "type": "text", "text": "看一下这道题" }
  ]
}
```

响应必须是**命名事件 SSE**，冒号后不能有空格：

```
event:message
data:{"role":"agent","type":"answer","answer_stream":"第一段","message_id":"1794559193700","agent_id":"cad4529937694bd6b3ab60e276d47c1b","is_finish":false}

event:message
data:{"role":"agent","type":"answer","answer_stream":"第二段","message_id":"1794559193700","agent_id":"cad4529937694bd6b3ab60e276d47c1b","is_finish":true}

event:done
data:[DONE]
```

约定：

- 首个 `event:message` 建议 1 秒内发出（状态帧），避免灵珠判超时
- 长任务期间每 8–10 秒写一行 `: heartbeat`（SSE 注释行，灵珠忽略内容但连接不断）
- `is_finish:true` 只在收尾帧发一次；最后必须跟 `event:done`
- 图片是临时 URL，需要服务端下载后转 base64 再喂模型（本项目已内置，含 SSRF 防护）
- `metadata.context` 的位置/天气/电量会拼进 system 提示

---

## 4. `GET /health`

```json
{"status":"ok","service":"rokid-bridge"}
```

无鉴权，便于隧道/反代健康检查。
