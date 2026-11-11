# 能力测试台

独立 Bun + Vite 项目，使用公开 SDK。应用 ID 从社区应用页面复制，保留 `../../sdk`：

```sh
bun install --frozen-lockfile
bun run dev
MINI_APP_ID=平台应用ID MINI_APP_VERSION=1.1.0 bun run build
```

预览地址：`http://127.0.0.1:5193/`。本地只预览布局，不模拟 SDK；上传 `dist/package/app.zip` 后运行。调试包使用 `bun run build:debug`。

## 展示内容

- 布局、主题、RTL、长文字、表单、指针捕获和鼠标锁定。
- 用户资料、288px 头像、信任等级、启动参数、权限和能力快照。
- 存档、Cookie、剪贴板、存档导入导出、文件保存、分享、常亮和手柄。
- 包内 WASM、classic 分包、ESM、Worker 和获批后的动态求值。
- 原生 Web Audio 与受控 AudioWorklet；处理器确认运行后播放 5 秒低音量音调，声音受顶部喇叭控制。
- 视频 MIME 提示、节目、状态、跳转、画中画、清晰度、音轨、字幕和时间线更新。
- 摄像头、录音、屏幕截图、定位，以及按清单选择和释放 USB、蓝牙设备。
- HTTP JSON/文本/字节、流、SSE、文件和分块上传；WS JSON/文本/二进制与连接恢复。
- 前端提醒、后台通知许可，以及应用调用、返回和动态传参。

采集、播放和网络操作由按钮触发。隐藏或离开页面会释放扩展操作的资源；“停止扩展操作”可主动停止。能力快照和 MIME 探测是支持提示，不能代替实际播放或设备结果。

日志只保存操作名、状态、错误码和耗时。资料、响应、截图和录音仅临时保留，可用“清除私人结果”清除。通知 token 不展示；后台示例只将其交给声明的端点。已经许可的提醒不会因停止等待而撤回。

SharedWorker、共享内存、多线程 WASM 与原生 WebRTC 尚未开放。示例权限较多，实际应用删去不用的权限。

## 配置外部功能

默认不配置外部地址。需要时修改 manifest 并重新构建、提审：

| 功能           | 配置                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| 普通 HTTP / WS | `endpoints.status`、`websockets.events`，界面可改别名                                                        |
| 流 / SSE       | `endpoints.stream`、`endpoints.events`；SSE 恢复需声明 `cursor` query                                        |
| 文件上传       | `endpoints.upload`，POST，接收原始文件或 multipart 的 `file` 字段                                            |
| 分块上传       | 上传端点声明 `upload_id`、`offset`、`end`、`total` query；响应 JSON 返回 `confirmedOffset`，须等于本块 `end` |
| 节目播放       | `endpoints.mediaPlaylist`，或输入引用已声明资源的节目 JSON                                                   |
| CDN 素材       | `remote_assets` 固定清单，界面填虚拟路径                                                                     |
| 外链           | `links` 中的完整地址                                                                                         |
| 应用调用       | `calls` 中的目标 ID；调用传入 `returnTo`，被调方可据此返回。query 是公开 URL 参数                            |
| 通知           | 正式版、登录后测试；后台方式配置 POST `endpoints.saveNotificationPermit`，接收 `{ token, deliveryUrl }`      |
| USB / 蓝牙     | `devices.usb`、`devices.bluetooth` 的别名及过滤清单，并申请对应权限                                          |

开发者服务使用自己控制的 HTTPS/WSS 地址，配置 CORS 并验证平台 JWT。分块上传需由业务服务确认位置；示例不自动重发写请求。更换文件会建立新的上传标识并重置位置。

完整配置见 [HTTP/WS](../../docs/sdk-network.md)、[连接恢复](../../docs/network-recovery.md)、[节目](../../docs/media-timelines.md)、[设备](../../docs/device-access.md)、[通知](../../docs/notifications.md) 和 [应用调用](../../docs/app-navigation.md)。

## 构建资源

构建脚本生成 WASM、短 WAV 和 MP4，打包模块图并计算 AudioWorklet 的 SHA-256。分包、模块、Worker、处理器源码在 `public/`，其角色在 manifest 的 `code` 中声明。

发布前检查窄屏、主题、权限拒绝、取消和离开后的清理；物理设备、系统分享和实际听觉输出需人工确认。父 DOM、浏览器隔离和完整审核流程由平台单独验收。
