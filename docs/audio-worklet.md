# 受控 AudioWorklet

AudioWorklet 用于在音频线程处理或生成声音。申请 `audio.webAudio` 和 `audio.worklet`，并将单文件处理器及原始字节 SHA-256 写入 `code.worklets`：

```json
{
  "permissions": ["audio.webAudio", "audio.worklet"],
  "assets": ["audio/tone.js"],
  "code": { "worklets": { "audio/tone.js": "替换为原文件的64位小写SHA-256" } }
}
```

`audio/tone.js`：

```js
registerProcessor("tone", class extends AudioWorkletProcessor {
  process(_inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) {
        for (let index = 0; index < channel.length; index++) {
          channel[index] = Math.sin(2 * Math.PI * 440 * (currentFrame + index) / sampleRate) * 0.1;
        }
      }
    }
    return true;
  }
});
```

使用 SDK 加载声明路径，节点和连接沿用原生 Web Audio：

```ts
const context = new AudioContext();
startButton.addEventListener("click", async () => {
  const resumed = context.resume();
  await sdk.audioWorklet.addModule(context, "audio/tone.js");
  const node = new AudioWorkletNode(context, "tone");
  node.connect(context.destination);
  await resumed;
});
```

只接受本次运行创建且仍打开的受控在线 `AudioContext`。不接受任意 URL、其他应用的 context 或 `OfflineAudioContext`；不要直接调用原生 `audioWorklet.addModule()`。同一 context 中同一路径只注册一次，不同文件的处理器名称仍需唯一。初始声音选择、喇叭开关和卸载清理继续生效。

可以用节点的 `port`、`parameters` 和其他原生节点组成处理图。处理器必须自包含；在构建时打包依赖，不依赖模块相对 URL 或对外联网。播放是否需要用户点击仍由浏览器决定。

`addModule(context, path, { signal, timeoutMs })` 支持取消和调用方期限，没有默认总超时。同一模块的并发等待者独立取消；所有等待者在原生加载开始后取消，或原生加载失败时，会静音并关闭该 context，已有音频图也随之结束。浏览器不支持撤销单次 worklet 注册；需要重试时创建新的 context。模块成功注册后的取消不会撤回已完成的调用。

处理器也可放入固定 `remote_assets`，使用 JavaScript MIME，同时申请 `assets.remote`。`code.worklets` 的摘要必须与远程声明一致；本地处理器在打包及提审时核对原始字节，BOM、换行或任何字节变化都需要更新摘要。单个处理器最大 32 MiB，此边界来自服务端代码资源准备，不改变普通 CDN 素材额度。

处理 `PERMISSION_DENIED`、`BROWSER_UNSUPPORTED`、加载失败、取消和 `APP_UNLOADED`。获取能力快照可用 `sdk.capabilities.get()` 的 `supported.audioWorklet`，批准状态仍以 `sdk.permissions.has()` 为准。
