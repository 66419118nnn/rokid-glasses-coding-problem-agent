# Rokid Glasses AIUI 拍题助手

戴在眼镜上的拍题应用：**单击镜腿拍照 → 自建桥接服务 → 大模型答题 → 主机用 g++ 真编译 + 跑用例 → 答案回到眼镜屏幕**。

不依赖灵珠的固定拍照模式，照片由眼镜全画幅拍摄后以原始字节上传；主机侧对 C++ 代码做真实编译验证，不是模型“嘴上自检”。

```
┌──────────── Rokid Glasses ────────────┐
│  AIUI 智能体（client/）                │
│  640×480 低码率取景                    │
│  单击镜腿 → takePhoto(mode=default)    │
│  原始图片字节 POST /ask-raw            │
└───────────────┬───────────────────────┘
                │ HTTPS（Caddy / 隧道 / 你的反代）
┌───────────────▼───────────────────────┐
│  主机桥接服务（server/，DSH 插件）      │
│  Bearer AK 校验 · 图片入库 · 会话      │
│  模型（OpenAI 兼容）→ g++ 编译 → 用例  │
│  /ask-raw · /ask · /chat · /health     │
└───────────────────────────────────────┘
```

## 特性

- **眼镜端**：低码率取景预览、单击镜腿拍摄、黑帧检测、`default → wide → telephoto` 模式回退、答案滚动翻页、等待时每 10 秒提示“还在思考”
- **主机端**：原始图片字节入口（无需眼镜端 base64）、12MB 摄入上限、`/chat` 灵珠命名事件 SSE、`/ask` JSON、`/ask-raw` 二进制
- **真自检**：C++ 代码 → WSL `g++` 编译 → 生成用例并运行 → 失败回灌重写 → 通过才输出最终版
- **可观测**：`[REQ]` / `[RESP]` / `[SELFTEST]` 日志，状态行显示来源模式、像素尺寸、平均亮度

## 目录

```
client/                 Rokid AIUI 智能体（单文件 .ink）
  config.js             ← 部署前填自己的 BRIDGE_URL / BRIDGE_AK
  pages/index/index.ink 取景、拍照、上传、翻页
server/                 DSH Host 插件（Node，无第三方依赖）
  index.js              HTTP 服务 + 会话 + 图片处理
  selftest.js           g++ 编译 + 用例验证
  cordis.patch.yml      DSH 插件挂载配置
docs/
  protocol.md           接口协议（/ask-raw、/ask、/chat）
  deploy.md             两端部署步骤
```

## 快速开始

### 1. 眼镜端（AIUI Studio）

1. 打开 `client/config.js`，填自己的桥接地址和 AK（**不要提交真实值**）
2. AIUI Studio（<https://aiui.rokid.com>）→ 新建智能体 → 本地导入 → 选择 `client/` 目录
3. 「真机调试」→ 填意图描述（例如“用户说看题时，拍下题目并给出解题思路和 C++ 代码”）→ 重新打包并保存
4. 乐奇 App → 设置 → 开发者 → 更新眼镜资源包
5. 眼镜上说“打开 xxx 智能体”，单击镜腿拍照

### 2. 主机端（DSH 插件）

1. 把 `server/` 放进 DSH 本地插件目录并在 profile 里 link
2. 在 profile 的 `cordis.patch.yml` 插入插件配置（见 `server/README.md`）
3. 安装 WSL + `build-essential`，确认 `wsl g++ --version` 可用
4. 重载 DSH，`curl http://127.0.0.1:8091/health` 返回 `{"status":"ok"}`
5. 需要公网时，用 Caddy / 隧道把入口暴露成 HTTPS（见 `docs/deploy.md`）

完整步骤、配置表、验收清单见 [docs/deploy.md](docs/deploy.md)；接口细节见 [docs/protocol.md](docs/protocol.md)。

## 交互（官方 AIUI 事件）

| 输入 | 事件 | 行为 |
|---|---|---|
| 镜腿单击 | `Enter` | 拍照（800ms 去重） |
| 上下滑动 | `ArrowUp` / `ArrowDown` | 答案翻页 |
| 页面按钮 | `bindtap` | 拍照（戒指/指针） |
| 双击镜腿 | 宿主系统退出 | 不使用 |

`GlobalHook` 是镜腿触摸信号，滑动也会上报，**不作为拍照触发**。

## 已知限制

- 当前 AIUI 运行时没有 `<camera>` 组件（会退化成 view）；`enableSystemPreview` 不驻留，所以取景用页面自己的低码率 MediaStream
- 取景流申请 4K 会拖垮眼镜端运行时，本项目固定 640×480
- 自检依赖 Windows + WSL；非 Windows 主机需要自行替换编译后端
- 自检的测试用例由模型生成，个别期望值可能本身有误；日志里会标记 `suspect-case`

## 安全 / 去敏

- `client/config.js` 里只有占位符；服务端 `accessKey` 写在 DSH 配置，不在仓库
- 真实部署请用独立、可随时撤销的 AK；如果不慎提交过，立即轮换
- 桥接服务只监听 `127.0.0.1`，公网入口加 HTTPS 并限制来源

## License

MIT