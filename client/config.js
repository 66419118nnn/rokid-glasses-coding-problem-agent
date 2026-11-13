// 部署前填成你自己的地址和 AK。不要把真实值提交到公开仓库。
// BRIDGE_URL 指向桥接服务的原始图片入口；路径按你的反代/隧道配置修改。
export const BRIDGE_URL = 'https://your-domain.example/rokid/ask-raw';

// 与服务端 accessKey（或旧配置里的 rokid_ak）保持一致。
export const BRIDGE_AK = 'REPLACE_WITH_YOUR_BRIDGE_ACCESS_KEY';

// 每张照片随请求带过去的问题文本。
export const QUESTION = '这是一道编程题的照片，请按系统提示解答。';