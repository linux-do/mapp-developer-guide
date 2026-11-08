# 浏览器操作与存档

新增能力需在 manifest 申请相应权限并提审。外链、文件保存和分享由平台展示操作内容，用户点击后执行；微应用不直接取得父页面或论坛 Cookie。

| 权限               | API                                                  |
| ------------------ | ---------------------------------------------------- |
| `links.open`       | `sdk.links.open(url, options?)`                      |
| `files.save`       | `sdk.files.save(name, data, options?)`               |
| `sharing.share`    | `sdk.sharing.share(data, options?)`                  |
| `screen.keepAwake` | `sdk.screen.setKeepAwake(enabled, options?)`         |
| `gamepad.read`     | `sdk.gamepad.get()` 或原生 `navigator.getGamepads()` |

这些异步 API 的 `options` 可传 `signal`、`timeoutMs`；不设默认总期限。处理 `USER_CANCELLED`、`BROWSER_UNSUPPORTED` 和浏览器拒绝；浏览器是否支持仍取决于系统和设备。

嵌入其他网站时，使用平台新生成的嵌入代码，它包含所需的 iframe 权限委派；旧嵌入代码需重新复制。外层网站的权限策略仍可能禁止常亮、分享、手柄、画中画或设备访问，微应用的批准权限不会覆盖外层网站限制。[摄像头、录音、屏幕、定位、USB 与蓝牙](device-access.md) 通过 SDK 的受控接口使用。

嵌入代码生成器的 `height` 参数接受正的安全整数像素值，默认 720，不另设高度范围。

## 外链、文件与分享

打开外链须申请 `links.open`，并在 manifest 的 `links` 数组提前声明完整地址：

```json
{
  "permissions": ["links.open"],
  "links": ["https://example.com/help"]
}
```

```ts
await sdk.links.open("https://example.com/help");
await sdk.files.save("progress.json", JSON.stringify({ level: 3 }));
await sdk.sharing.share({
  title: "我的作品",
  url: "https://example.com/art/123",
});
```

`links.open` 按完整字符串匹配清单，query 和 `#` 片段也必须一致；不支持域名、路径前缀或通配符匹配。URL 使用不含账号密码的绝对 HTTP(S) 地址，最长 16 KiB；国际域名使用 Punycode，路径、query 和 fragment 中的非 ASCII 字符使用百分号编码。不接受原始空白、反斜杠、无效百分号转义或相对路径段。审核页面展示完整清单，变更地址需重新构建、提审。

未声明的目标返回 `LINK_NOT_ALLOWED`，不弹确认框、不打开页面。缺少清单的旧版即使曾获批，也不能打开外链；其实际 `links.open` 权限会被移除，需处理 `PERMISSION_DENIED`。已声明目标仍需用户确认，在新标签页打开并隔离 opener/referrer。校验针对 SDK 打开时的初始 URL，外部网站后续重定向由浏览器处理。

文件内容支持字符串、Blob、ArrayBuffer 和 typed array；文件名不能含路径、控制字符或方向覆盖字符，下载按普通二进制交付，保留原始字节。分享支持 `title`、`text`、HTTP(S) `url` 和 `File[]`，目标由系统分享面板提供；分享完成不代表接收方已收到或处理内容。

## 屏幕常亮与手柄

```ts
await sdk.screen.setKeepAwake(true);
// 结束游戏或不再需要时：
await sdk.screen.setKeepAwake(false);

function updateInput() {
  for (const gamepad of sdk.gamepad.get()) {
    if (gamepad?.connected) {
      updateAxes(gamepad.axes);
      updateButtons(gamepad.buttons);
    }
  }
  requestAnimationFrame(updateInput);
}
```

常亮在页面隐藏时释放，恢复可见后按本次请求重新申请；关闭应用会释放。系统省电策略仍可拒绝或撤销常亮。手柄需浏览器支持且设备已被浏览器识别，可能要求先按手柄按钮或在应用内点击；每帧重新获取状态，不经过高频 RPC。离开游戏时停止自己的动画循环。

## 存档备份与恢复

`localStorage.exportData()` 需要 `storage.read`，返回 `{ format: 1, entries: [[key, value], ...] }`，仅含当前应用、当前正式或沙盒环境的字符串存档，不含 Cookie。

```ts
const snapshot = await sdk.localStorage.exportData();
await sdk.files.save("save.json", JSON.stringify(snapshot));

// file 来自用户主动选择的 input[type=file]。
const restored = JSON.parse(await file.text());
await sdk.localStorage.importData(restored); // 合并；相同 key 使用导入值。
```

导入需要 `storage.write`；确实需要完全替换时传 `{ replace: true }`。格式、值类型和重复 key 会在写入前检查，合并或替换在一个事务内完成；失败保留原存档。导入导出也支持 `signal`、`timeoutMs`。它们不提供跨设备自动同步，也不把客户端存档当作成绩、余额或奖励的可信依据。
