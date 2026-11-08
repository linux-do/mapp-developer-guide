# HTTP 与 WebSocket

在 manifest 声明应用需要的业务接口，再通过 SDK 调用。地址使用 HTTPS/WSS，可指定合法 TLS 端口。固定素材使用 [`remote_assets` 清单](developer-guide.md#开发者-cdn-素材)，业务数据和用户上传文件通过下面的接口传输。

## 声明端点

```json
{
  "permissions": ["user.read", "network.request", "network.websocket"],
  "endpoints": {
    "createMessage": {
      "url": "https://api.example.com/messages",
      "method": "POST",
      "query": ["room"],
      "auth": "platform"
    },
    "upload": {
      "url": "https://api.example.com/upload",
      "method": "POST",
      "auth": "platform"
    }
  },
  "websockets": {
    "events": {
      "url": "wss://api.example.com/events",
      "query": ["room"],
      "auth": "platform"
    }
  }
}
```

替换为自己有权运营的服务。调用者只传端点名和获准动态 query，不能覆盖 URL、固定 query 或 headers。URL 不带凭据、片段、相对路径段、反斜杠或未编码非 ASCII 字符。`mini_app_token` 是保留参数，不能声明。

| 项目                  | 限制                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 业务 URL              | 编码后最多 16 KiB，包含动态 query；端口与路径按审核声明匹配                                                                       |
| 端点名与动态 query 键 | 1–64 个 ASCII 字母、数字、点、下划线或连字符；query 键必须提前声明，不能覆盖固定 query；值为字符串                                |
| HTTP 常量 headers     | 在 manifest 声明；不允许鉴权、Cookie、Host 等敏感头                                                                               |
| WS 子协议             | 在 manifest 的 `protocols` 声明；不支持自定义握手 headers                                                                         |
| 声明大小              | 总声明与其他字段共用 manifest 的 1 MiB 预算；单端点最多 64 KiB，保证授权凭据可正常签发；不另设端点、query、header、子协议数量配额 |

公开 HTTP 和 WS 可用 `auth: "none"`；站点允许匿名应用时，访客也可调用获批 `network.request` / `network.websocket` 的这些端点，不附带平台 JWT。受保护端点使用 `auth: "platform"`，还需获准 `user.read` 并登录；服务端须验证 JWT 并检查业务权限，见 [服务端鉴权](server-auth.md)。匿名不能取得平台身份 JWT。

## HTTP

```ts
const response = await sdk.http.request("createMessage", {
  query: { room: "lobby" },
  json: { text: "Hello" },
});
showResult(response.status, response.body);
```

方法由 manifest 固定；可选 `method` 必须与声明一致。支持 GET、HEAD、POST、PUT、PATCH、DELETE、OPTIONS，GET/HEAD 无正文。用 `json` 发送 JSON，或用 `body` 发送文本、`URLSearchParams`、`File`、`Blob`、`ArrayBuffer`、typed array、`FormData`，两者不能同时使用。

返回 `{ status, headers, body }`。`headers` 使用小写键，包含浏览器通过 CORS 允许读取的响应头，过滤认证、Cookie 等凭据头；需要读取 `ETag`、`Link`、`Retry-After` 或自定义头时，服务端在 `Access-Control-Expose-Headers` 中声明。默认 `responseType: "json"`，空 JSON 正文为 `null`；`"text"` 返回字符串，`"bytes"` 返回 `Uint8Array`。`request()` 完整接收后才返回，容器不执行响应中的 HTML、脚本或其他数据。

可通过原生 `<input type="file">` 选择文件，再将选中的 `file` 传给已声明的 `upload`：

```ts
const controller = new AbortController();
const form = new FormData();
form.append("file", file);
const result = await sdk.http.request("upload", {
  body: form,
  signal: controller.signal,
  timeoutMs: 120_000,
});
// 用户取消时调用 controller.abort()。
```

无需把文件转成 Base64；容器按正文类型设置 Content-Type，FormData 的 boundary 由浏览器生成。平台不另设正文/响应的小额字节配额或默认总超时；使用可选 `signal` 和 `timeoutMs` 控制请求。实际可处理大小取决于浏览器、网络和开发者服务。

HTTP 不携带 Cookie，默认不跟随重定向。确需跳转时，在源 HTTP 端点上声明 `redirectTo`，值为另一个已审核的 GET/HEAD 端点名。只有源响应发生重定向时才调用该目标，忽略响应 Location；目标重新授权，源请求的正文、动态 query、headers 和 JWT 不向目标转发。目标可继续声明下一跳，循环声明会被拒绝。WS 不使用此字段。

```json
{
  "endpoints": {
    "download": { "url": "https://api.example.com/download", "method": "GET", "auth": "platform", "redirectTo": "file" },
    "file": { "url": "https://files.example.com/current.bin", "method": "GET", "auth": "none" }
  }
}
```

服务须允许论坛 origin 的 CORS、OPTIONS、Authorization、Content-Type 和声明常量头，错误响应也要有 CORS。直接填写最终端点通常更简单。

### 下载进度与流式读取

`request()`、`stream()` 和 `events()` 均可传 `onDownloadProgress({ loaded, total })`。`loaded` 是本次已读取的正文解码后字节数；`total` 可能未知，不应直接假设可以计算百分比。跨域响应只有明确暴露 `Content-Encoding: identity` 且 `Content-Length` 合法时才提供总量提示。回调抛错会取消读取。

```ts
const response = await sdk.http.request("download", {
  responseType: "bytes",
  onDownloadProgress: ({ loaded, total }) => updateProgress(loaded, total),
});
```

较大的响应可使用 `stream()`：浏览器交付响应头后即可取得 `ReadableStream<Uint8Array>`，无需等待正文完整下载。部分浏览器会等首块正文到达后才交付响应头，开流期间也可通过 signal 取消。端点、请求方法、正文和权限规则与 `request()` 相同，不传 `responseType`。

```ts
const controller = new AbortController();
const response = await sdk.http.stream("download", {
  signal: controller.signal,
});
const reader = response.body.getReader();
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    consumeBytes(value);
  }
} finally {
  await reader.cancel().catch(() => {});
  reader.releaseLock();
}
```

按需读取会向上游传递背压。`signal` 和可选 `timeoutMs` 覆盖开流及正文读取全过程，默认没有总期限；停止读取时须调用 `reader.cancel()` 或取消 signal，未锁定的正文也可直接 `response.body.cancel()`。不要仅丢弃返回值；离开应用时会统一释放连接。

当前进度回调针对响应下载。`network.uploadChunks` 可分片读取 Blob 或字节流，按服务端确认的 offset 报告上传进度并从已确认位置恢复，见[上传工具](network-recovery.md)；它不把排队字节误报为服务器已收到。HTTP 流式接口也不改变固定 CDN 素材须完整校验后交付的规则。

### SSE 事件

声明返回 `text/event-stream` 的 HTTP 端点后，可使用 `events()` 直接逐条读取事件；支持多行 `data`、`event`、`id`、`retry`，以及跨数据块的 UTF-8 和 CR/LF 换行。需要固定 Accept 时在端点的 `headers` 声明 `"Accept": "text/event-stream"`。

服务端建立连接后应尽早发送并 flush 一条注释（如 `: connected\n\n`）或事件，并关闭代理的响应缓冲，避免空等首块正文。

```ts
const response = await sdk.http.events("updates", {
  signal: controller.signal,
});
const reader = response.body.getReader();
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    handleEvent(value.event, value.data, value.id);
  }
} finally {
  await reader.cancel().catch(() => {});
  reader.releaseLock();
}
```

事件 `data` 保持字符串，不自动解析 JSON；`id` 沿用最近的有效事件 ID，默认空字符串。可选 `retry` 为服务器建议的重连毫秒数，SDK 不自动重连或重放请求；需要续传时由应用保存 ID，并通过预先声明的 query 参数传回服务。没有以空行结束的尾部事件会被丢弃。流式 API 需要支持它的新运行时；旧页面应刷新后使用。

## WebSocket

```ts
const connection = await sdk.webSocket.connect("events", {
  query: { room: "lobby" },
});
const off = connection.on("message", showMessage);
connection.on("error", ({ code }) => showError(code));
connection.on("close", ({ code }) => showClosed(code));
await connection.send({ type: "join" });
// 离开该功能时：
await connection.close();
off();
```

连接就绪后使用 `send/close/on`；`on` 支持 `message/error/close` 并返回取消订阅函数。`send` 保留原来的 JSON 编码，也接受 `Blob`、`ArrayBuffer` 和 typed array 发送二进制；普通原始文本使用 `sendText`。收到的二进制为 `Uint8Array`；默认 `textMode: "auto"`，文本能解析为 JSON 时返回解析结果，否则返回原始字符串。需要原文时，在 `connect()` options 中指定 `textMode: "text"`，例如 `"123"` 会保持字符串；此选项不改变二进制消息或发送方式。

服务在 upgrade 前验证 `mini_app_token` query 中的 JWT，握手后按业务协议传输消息。握手拒绝重定向。WSS 不能使用论坛同一 hostname，包括不同端口。

不另设连接数、单条消息大小或每秒消息数的业务配额；浏览器发送缓冲拥塞时等待可发送。`connect` 和 `send` 可传 `signal`、`timeoutMs`，默认不设总超时。连接就绪后应及时订阅消息。

JWT 在握手时验证；已建立连接没有平台固定时长限制，也不会因握手 JWT 到期而断开。需要自动恢复时使用 [network.reconnectSocket / reconnectEvents](network-recovery.md)，每次重连都会重新取得有效授权；已发出的写入不会自动重放。

`close(code?, reason?)` 可使用 1000 或 3000–4999，reason 最多 123 个 UTF-8 字节。远端关闭的数字代码会保留，远端原因文本仍过滤，避免回显凭据。

## 授权与错误

JWT 有效期为 15 分钟。HTTP 返回 401 时本次请求失败，下次调用重新获取授权；写操作不会自动重试。

退出或失去使用权限时应用会停止。已签发 JWT 可能使用到到期；开发者仍需自己的账号、资源权限和连接限额。

处理权限、参数、浏览器网络失败、取消、`TIMEOUT`、`SOCKET_CLOSED` 和 `APP_UNLOADED`；平台授权签发仍有服务端限流。不要改用原生网络 API。取消等待不能撤销已完成的业务写入，也不会自动重放写操作。
