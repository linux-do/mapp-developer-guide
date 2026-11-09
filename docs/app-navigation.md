# 应用调用与返回

`app.call` 在当前标签页打开另一个微应用，原应用随跳转卸载。`app.return` 跳回当前调用栈中的应用，并重新启动它。两者均通过启动 query 传递业务数据，不保留旧页面的 JS 变量、画布或运行实例。

## 声明调用目标

调用方申请 `app.call`，并在 manifest 的 `calls` 数组填写平台分配的目标应用 ID：

```json
{
  "permissions": ["app.call", "launch.read"],
  "calls": ["019a2010-1111-7111-8111-111111111111"]
}
```

上面的 ID 仅为格式示例，使用时替换为实际分配值。无需声明 URL、query 名称或取值；审核会展示目标 ID，管理员还可查看现有目标的名称和详情。新增或更改调用目标需要重新构建、提审。没有 `calls` 的旧版本仍可运行，但不能调用其他应用。

```ts
await sdk.app.call(targetAppId, {
  action: "choose",
  category: "tools",
  tag: ["new", "popular"],
});
```

目标运行当前生效的正式版，并重新检查访问资格和权限。跳转使用同一个标签页；嵌入页面只切换自身的论坛页面，保持嵌入模式。

## 返回与接收数据

例如 A → B → C，C 可以返回 B，也可以直接返回 A：

```ts
await sdk.app.return(callerAppId, {
  action: "chosen",
  item_id: String(selectedItemId),
});
```

返回目标必须是当前调用栈中的祖先，不需要额外权限或 manifest 声明。直接返回 A 会移除后面的 B、C；若同一个应用在栈中出现多次，匹配最近的祖先，不匹配当前这一层。独立打开的应用没有可返回的调用关系。

重新启动后的 A 使用 `launch.read` 读取结果：

```ts
const { query } = await sdk.launch.getParameters();
if (query.action?.[0] === "chosen") {
  showSelection(query.item_id?.[0]);
}
```

A 可以在调用 query 中约定一个 `return_app_id`，让 B 知道要返回哪个应用。该字段仍是普通业务数据，不能作为身份凭据；宿主会另行验证返回目标确实在当前调用栈中。

`app.call/return` 的 Promise 用于处理提交跳转前的错误，**不会跨页面等待业务结果**。导航提交后原实例即卸载，后续业务应在目标的新启动流程中处理。需要保留的数据请在跳转前通过应用自己的存储保存。普通页面上的返回按钮会返回上一层应用；到达栈根后返回原广场分页和筛选。

## 参数与错误

```ts
sdk.app.call(appId, query?, { signal, timeoutMs });
sdk.app.return(appId, query?, { signal, timeoutMs });
```

- `query` 的值只接受字符串或字符串数组；接收时统一为字符串数组。重复值保留顺序。省略 query 表示空参数，不自动合并目标旧参数，也不传递 hash。
- 应用 ID 使用平台分配的完整原值。调用目标只能来自 `calls`；返回目标只能来自当前调用栈。
- 不接受 `embed_mode`、运行令牌、包密钥、CSRF、票据和导航内部参数等平台保留字段。普通 query 会出现在地址栏与浏览器历史中，请勿放入密钥。
- `signal`、`timeoutMs` 可在提交前取消；已提交的跨页导航不能撤销。不额外弹授权框，调用权限与目标由版本审核控制。
- 刷新当前页面可保留有效调用关系；修改地址中的启动参数、切换身份或关闭标签页后，不应依赖原调用关系。浏览器历史中的旧地址不能恢复已被返回操作裁掉的层级。
- `PERMISSION_DENIED`：未获批 `app.call`；`APP_NOT_ALLOWED`：调用目标未声明；`APP_NOT_IN_CALL_STACK`：返回目标不在当前调用栈；`APP_UNAVAILABLE`：目标当前不可用；`APP_NAVIGATION_UNAVAILABLE`：浏览器无法保存导航状态；`INVALID_ARGUMENTS`：ID 或 query 无效。另需处理取消、超时和实例卸载。

应用之间不共享身份令牌、权限或存储。query 是公开的启动输入，接收方应按业务需要验证；它不能代替服务端身份验证。
