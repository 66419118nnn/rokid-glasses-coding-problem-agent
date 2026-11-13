# 部署

分两端：眼镜上的 AIUI 智能体（client），和主机上的桥接服务（server）。可以只开一端调试，但完整链路需要两端都通。

---

## A. 眼镜端（client）

### 1. 填配置

编辑 `client/config.js`：

```js
export const BRIDGE_URL = 'https://<your-domain>/rokid/ask-raw';
export const BRIDGE_AK = '<与 server accessKey 一致>';
export const QUESTION = '这是一道编程题的照片，请按系统提示解答。';
```

### 2. 导入 AIUI Studio

1. 打开 <https://aiui.rokid.com>，用 Rokid 账号登录
2. 新建智能体 → **本地导入** → 选择 `client/` 目录（目录里要有 `app.json`）
3. 进入项目 → **真机调试** → 填「意图描述」，例如：
   `用户说看题时，拍下题目并给出解题思路和 C++ 代码`
4. 点 **重新打包并保存**，等左侧状态变为「已同步」、顶部出现「调试版本已就绪」

### 3. 推到眼镜

1. 乐奇 App → 设置 → 开发者 → **更新眼镜资源包**，等「智能体资源包下载成功」
2. 眼镜上说：**“乐奇，打开 <你的智能体名> 智能体”**
3. 对准题目 → **单击镜腿**拍照

> `client/` 里的 `.aix/agent-id` 是导入时生成的，请不要跨账号复用；公开仓库已忽略。

### 4. 验收

- 取景画面正常（640×480 低码率预览）
- 拍照后状态行出现 `来源：default 3024×4032 亮度 XX`
- 答案出来后上下滑动可翻页，且**不会**再触发拍照
- 等待时状态行每 10 秒刷新「主机还在思考，已等 N 秒…」

---

## B. 主机端（server）

### 1. 依赖

- Node.js 20+（DSH 自带运行时亦可）
- DSH（DeepSeek Harness）；插件通过 `agents` / `agentDefaultModel` / `attachments` / `llm` 注入
- Windows + WSL，且 `wsl g++ --version` 可用（Ubuntu 建议 `apt install build-essential`）

### 2. 安装插件

把 `server/` 放到 DSH 本地插件目录（例如 `~/.dsh/local-plugins/rokid-bridge-dsh`），在 profile 的 `package.json` 里 link：

```json
"dependencies": { "rokid-bridge-dsh": "link:C:/path/to/rokid-bridge-dsh" }
```

在 profile 的 `cordis.patch.yml` 里插入配置（注意：同 id 的后续 patch 会覆盖 `config`，要一次写全）：

```yaml
- insert:
    - id: rokid-bridge-dsh
      name: 'rokid-bridge-dsh'
      config:
        port: 8091
        accessKey: '<YOUR_ACCESS_KEY>'
        selftestForAsk: true
        reasoningEffort: max
        selftestEscalations: 1
        selftestBudgetSeconds: 190
        selftestWslDistro: ''        # 留空 = 默认 WSL 发行版
```

重载 DSH 后：

```bash
curl http://127.0.0.1:8091/health
# {"status":"ok","service":"rokid-bridge"}
```

### 3. 公网入口

桥接服务只监听回环，公网访问需要反代或隧道。

**Caddy（推荐，自动 HTTPS）**

```caddyfile
<your-domain> {
    handle_path /rokid/* {
        reverse_proxy 127.0.0.1:8091 {
            flush_interval -1
        }
    }
}
```

> `flush_interval -1` 用于 SSE 流式输出，`/chat` 必需；`/ask-raw` 是普通 JSON，不受影响。
> 如果 Caddy 配置了 `admin off`，改完要 `systemctl restart caddy`，`reload` 无效。

**Cloudflare Tunnel（没有公网 IP 时）**

```bash
cloudflared tunnel --url http://127.0.0.1:8091
```

把生成的 `https://xxx.trycloudflare.com` 填进 `client/config.js` 的 `BRIDGE_URL`（路径加 `/ask-raw`）。

### 4. 反向隧道（可选）

主机在 NAT 后面时，也可以让主机主动 `ssh -R 127.0.0.1:8091:127.0.0.1:8091` 到一台有公网 IP 的跳板机，再由跳板机的 Caddy 反代。只绑跳板机的回环地址，不要用 `0.0.0.0`。

---

## C. 验收清单

| 项 | 命令 / 操作 | 期望 |
|---|---|---|
| 健康 | `curl <base>/health` | `{"status":"ok"}` |
| 鉴权 | 不带 AK 调 `/ask-raw` | `401` |
| 文字 | `POST /ask` 纯文本 | `200` + 答案 |
| 图片 | `POST /ask-raw` 传一张题图 | `200`，答案能读出题干 |
| 自检 | 日志出现 `[SELFTEST] compile=ok cases=N/N` | 答案末尾「已通过编译与 N 组用例」 |
| 眼镜 | 单击镜腿拍一张 | 屏幕出答案，状态行有来源/像素/亮度 |

---

## D. 常见问题

| 现象 | 排查 |
|---|---|
| 眼镜显示“手机已断开” | 多为取景流过大拖垮运行时；确认预览是 640×480，不要申请 4K |
| 拍出来全黑 | 检查 `takePhoto` 的 `mode`；代码会依次退 `default → wide → telephoto`，状态行会显示实际模式与亮度 |
| 眼镜端超时 | 眼镜 fetch 超时 240s、自检预算 190s；难题可调大两处，但要保证“预算 + 模型生成 < 客户端超时” |
| 答案带“某组用例未通过” | 编译通过，个别生成用例期望值可疑（日志 `suspect-case=1`），不是代码没跑 |
| 公网 502 | 看隧道是否在线、反代是否指向 8091、`/health` 是否通 |
| 日志乱码 | 日志按 UTF-8 写入；Windows 下用 `Get-Content -Encoding UTF8 -Tail 60` |