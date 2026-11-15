# 拍题解题（Rokid Glasses AIUI 智能体）

Rokid 眼镜上的拍题应用：单击镜腿触发拍照，照片上传到自建桥接服务，答案显示在眼镜屏幕上。

## 交互

- 单击镜腿（`Enter`）拍照，800ms 去重；滑动不触发拍照
- 上下滑动（`ArrowUp` / `ArrowDown`）翻答案页
- 戒指/指针点「拍摄」按钮也能拍
- 双击镜腿是宿主退出，不使用

## 取景

- 页面用 `getUserMedia({ video: { width: 640, height: 480 } })` 拉低码率预览流，绑定 `<video>` 取景
- 拍照前停止预览流，避免和系统相机抢设备
- 当前 AIUI 运行时没有 `<camera>` 组件（会退化成 view），`enableSystemPreview` 也不会停留

## 拍摄

- `wx.media.createCameraContext().takePhoto({ quality: 'high', mode: 'default' })`
- 黑帧检测：抽样算平均亮度，低于 12 重拍；`default` 无画面时依次退 `wide`、`telephoto`
- 拍完进入确认页：显示实际照片缩略图，确认题目完整、数据范围都在画面里再提交；否则重拍
- 状态行显示来源模式、像素尺寸、平均亮度

## 上传

- `POST <BRIDGE_URL>?q=...`，原始图片字节，`Authorization: Bearer <BRIDGE_AK>`，超时 600 秒
- 等待期间每 10 秒刷新「主机还在思考，已等 N 秒…（可以继续等）」
- 配置在 `config.js`，部署前填自己的地址和 AK