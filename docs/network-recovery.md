# 网络恢复与分片上传

`sdk.network` 提供可选的连接恢复和分片上传工具。原有 `http.request`、`http.stream`、`http.events` 和 `webSocket.connect` 保持单次调用行为；仅使用本文的工具时才自动重连。

## WebSocket 恢复

```ts
const connection = sdk.network.reconnectSocket("events", {
  query: { room: "lobby" },
  textMode: "text",
  onOpen: async (socket, { reconnected, signal }) => {
    await socket.send({ type: "subscribe", room: "lobby" }, { signal });
    showConnectionState(reconnected ? "已恢复" : "已连接");
  },
  onMessage: (message) => handleMessage(message),
});

await connection.ready;
await connection.send({ type: "message", text: "Hello" });
// 用户离开这个功能时停止重连。
await connection.close();
```

`onOpen` 在每次连接后执行，由应用明确恢复订阅或同步业务状态。`ready` 在首次连接及该回调完成后成功；`done` 在连接结束后完成，取消、卸载和不可恢复错误会使它拒绝。`state` 为 `connecting`、`open`、`waiting` 或 `closed`。

断线期间 `send`、`sendText` 立即失败，不排队。已经发送的写入不会自动重放，响应丢失时由业务服务的操作 ID、幂等规则或状态查询确认结果。消息回调按到达顺序调用；异步回调可并行完成，需要串行业务处理时由应用管理。

默认对连接失败和非正常断线重试；服务端正常关闭（1000）结束连接。权限失效、参数错误、应用卸载等不会重试。恢复回调或消息回调失败也会结束连接。

## SSE 恢复与游标

服务端须提供 GET 事件端点，并在 manifest 的 `query` 中声明续传参数。例如下面的服务约定用 `cursor` 表示上次事件 ID：

```json
{
  "endpoints": {
    "updates": {
      "url": "https://api.example.com/updates",
      "method": "GET",
      "query": ["room", "cursor"],
      "auth": "platform",
      "headers": { "Accept": "text/event-stream" }
    }
  }
}
```

```ts
const events = sdk.network.reconnectEvents("updates", {
  query: { room: "lobby" },
  lastEventIdQuery: "cursor",
  lastEventId: savedCursor,
});
const reader = events.body.getReader();
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await applyEvent(value);
    saveCursor(events.lastEventId);
  }
} finally {
  await reader.cancel().catch(() => {});
  reader.releaseLock();
}
```

读取时才建立连接；处理完当前事件前不会继续预读。连接结束或暂时失败后按需重新连接，通过声明过的 query 传回 `lastEventId`，不增加 `Last-Event-ID` 等动态头。游标由服务定义，可能重复交付事件，业务处理应按事件 ID 去重。这个工具不提供恰好一次交付保证。

单独的 `id:` 和 `retry:` 控制记录也会更新恢复状态。空 `id:` 清空游标，下次请求省略续传参数。`lastEventId` 保存在当前实例；跨页面继续时由应用保存并在下次传入。服务器的有效 `retry` 毫秒值作为下次等待的最低值。HTTP 204 正常结束；408、429 和 5xx 可重试，其他错误状态或非 SSE 内容默认结束。

## 重试、取消与期限

两种恢复工具都接受 `retry`：

```ts
{
  initialDelayMs: 500,
  maxDelayMs: 30000,
  factor: 2,
  jitter: 0.2,
  onRetry: ({ attempt, delayMs, error }) => showRetry(attempt, delayMs),
}
```

这些值是默认退避策略，可由应用调整。连续失败时指数退避；`jitter` 避免大量客户端同时重试。`shouldRetry(error, attempt)` 可定制非权限类错误的重试决定，抛错则终止。恢复过程不设默认总期限；可传 `signal` 或 `timeoutMs` 控制整个恢复实例。关闭工具或离开应用会取消正在建立的连接、读取和等待。

## 可恢复分片上传

`uploadChunks` 接收 `Blob`、`File` 或 `ReadableStream<Uint8Array>`，顺序产生有限大小的块。`send` 回调负责调用应用自己的审核端点和解析服务器确认。平台不规定上传会话、分片 URL、校验和或完成提交协议。

下面仅演示一种自定义协议：服务提供上传会话 ID，接受 `upload`、`offset`、`end` query，并返回 `{ confirmedOffset }`。这些 query 键须在 manifest 中提前声明。

```ts
const controller = new AbortController();
const result = await sdk.network.uploadChunks(file, {
  chunkSize: 1024 * 1024,
  resumeOffset: serverConfirmedOffset,
  signal: controller.signal,
  send: async ({ chunk, offset, end, signal }) => {
    const response = await sdk.http.request("uploadPart", {
      query: { upload: uploadId, offset: String(offset), end: String(end) },
      body: chunk,
      signal,
    });
    const body = response.body;
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.confirmedOffset !== "number"
    ) {
      throw new Error("上传确认无效");
    }
    return { confirmedOffset: body.confirmedOffset };
  },
  onProgress: ({ confirmedOffset, total }) => {
    showConfirmedProgress(confirmedOffset, total);
  },
});
```

默认每块 1 MiB，可自定正整数 `chunkSize`，不限制整个文件大小。每块必须收到精确等于 `end` 的确认才发送下一块；`onProgress` 表示服务器已确认的偏移量，不是实时上传线速进度。Blob 从 `resumeOffset` 切片；流来源必须已位于该偏移，工具不会读取并丢弃前缀。流可提供整个文件的 `total`，未知时省略。

中断会抛出带 `confirmedOffset` 和原始 `cause` 的错误。请求可能已到达服务器但确认丢失，因此不要直接把本地偏移当作服务器事实：再次查询服务器确认位置，再调用工具恢复。失败块不会自动重放。需要校验整个文件或最终提交时，由应用在分片完成后调用对应业务端点。

取消或卸载会结束上传及源读取；进度回调失败也会停止后续分片。HTTP 仍省略 Cookie、拒绝重定向，并仅访问审核过的端点。
