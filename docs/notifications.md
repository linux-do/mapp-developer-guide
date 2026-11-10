# 通知

通知以论坛私信送达。每次在用户操作应用时，提前申请下一次投递；投递时不再弹窗。仅登录用户的正式应用可申请。

| 方式 | 期限 | 用途 |
| --- | --- | --- |
| 前端提醒 | 同意后 24 小时内 | 提交内容和时间，由平台定时发送 |
| 后台通知 | 同意后 30 天内 | 取得一次性 token，由自己的后端提交投递 |

## 声明模板

在 manifest 中申请权限并声明模板，改动后需重新提审：

```json
{
  "permissions": ["notifications"],
  "notifications": {
    "ready": {
      "title": "%app_name%：%item% 已就绪",
      "body": "回来查看 %item% 吧。",
      "examples": { "item": "农作物" }
    }
  }
}
```

模板 ID 和变量名以英文字母开头，其后可用字母、数字、下划线，最长 64 字符。`%app_name%` 由平台填写；其他变量通过 `params` 传入字符串。`examples` 为审核示例。

标题、正文使用纯文本。平台自动加 `【微应用】` 标题前缀，并在正文末尾用横线分隔应用名、打开链接和关闭通知提示，无需自行拼接。

`reason` 为必填的申请理由。

## 前端提醒

```ts
remindButton.addEventListener("click", () => {
  sdk.notifications.request("ready", {
    mode: "frontend",
    reason: "收获提醒",
    at: Date.now() + 60 * 60 * 1000,
    params: { item: "农作物" },
    query: { view: "farm" },
  }).then(showScheduled).catch(showError);
});
```

`at` 是毫秒时间戳，须在当前时间至 24 小时截止时间之间，省略时尽快发送。`params` 必须齐全。返回 `{ mode, expiresAt, scheduledAt }`，时间单位均为毫秒；关闭应用后提醒仍有效。

## 后台通知

同样在用户操作中申请，把返回的 `token` 和 `deliveryUrl` 通过已声明的业务端点交给自己的后端：

```ts
notifyButton.addEventListener("click", () => {
  sdk.notifications.request("ready", { mode: "backend", reason: "任务完成提醒" })
    .then(async (permit) => {
      if (permit.mode === "backend") {
        await sdk.http.request("saveReminder", {
          body: { token: permit.token, deliveryUrl: permit.deliveryUrl },
        });
      }
    }).catch(showError);
});
```

`saveReminder` 需声明为业务端点并申请 `network.request`。申请时可传 `params`、`query`，不能传 `at`。

后端在到期前向 `deliveryUrl` 提交：

```sh
curl -X POST 'https://forum.example/mini-app-api/notification-deliveries' \
  -H 'Authorization: Bearer <notification-token>' \
  -H 'Content-Type: application/json' \
  --data '{"params":{"item":"农作物"},"query":{"view":"farm"}}'
```

接收入队返回空的 `202 Accepted`。token 无需解析；不要放进 URL、日志或公开存储。

投递时省略 `params` 或 `query` 会使用申请时的值，提供则完整替换对应字段。变量必须齐全；`query` 用于打开本应用，值可为字符串或字符串数组。收件人和模板由许可固定，不能另传。

超时可用同一 token 和相同参数重试；入队后不能替换内容。一次许可只发送一条私信，发送后 token 失效。

## 通知开关与错误

用户同意申请后，应用通知开关保持开启，可在应用信息中关闭。关闭期间不投递，未过期许可仍保留；重新开启不会免除新通知的单次申请。

除 SDK 的取消、无用户操作等常规错误外，需处理：

| 代码 | 含义 |
| --- | --- |
| `NOTIFICATIONS_DISABLED` | 用户已关闭通知 |
| `NOTIFICATION_TOKEN_INVALID` | token 无效、过期或已发送 |
| `NOTIFICATION_INVALID_ARGUMENTS` | 模板、变量或时间无效 |
| `NOTIFICATION_PERMISSION_DENIED` | 应用、版本或用户不可用 |
| `NOTIFICATIONS_UNAVAILABLE` | 平台通知暂不可用 |
