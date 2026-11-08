# 分包、模块与 Worker

额外代码须随版本声明。包内代码加入 `assets`；CDN 代码加入固定的 `remote_assets`，同时在 `code` 中声明执行角色。CDN 的 URL、大小、JavaScript MIME 与 SHA-256 随审核版本固定，使用前完整校验。SDK 接口只接受虚拟路径。

```json
{
  "permissions": ["code.load", "code.modules", "workers.create"],
  "assets": ["chunks/editor.js", "modules/game.mjs", "modules/math.mjs", "workers/sum.js"],
  "code": {
    "scripts": ["chunks/editor.js"],
    "modules": ["modules/game.mjs", "modules/math.mjs"],
    "workers": ["workers/sum.js"]
  }
}
```

旧 manifest 没有 `code` 时，已声明的包内 `.js/.mjs` 仍可作为 classic 分包或 Worker 使用；ESM 始终需要明确的 `code.modules` 列表。

## Classic 分包

```ts
await sdk.scripts.load("chunks/editor.js");
globalThis.editor.open();
```

分包构建为单文件 classic/IIFE，共用应用窗口；同一路径本次只执行一次，并发加载合并。CDN 分包还需 `assets.remote`，MIME 使用 `text/javascript` 或 `application/javascript`。

## ESM

```ts
const game = await sdk.modules.import("modules/game.mjs");
game.start();
```

模块内引用同一 `code.modules` 图中的文件，使用固定名称 `@mini-app/<虚拟路径>`：

```js
import { add } from "@mini-app/modules/math.mjs";
export const result = add(1, 2);
export const loadMath = () => import("@mini-app/modules/math.mjs");
```

支持浏览器原生 ESM 导出、依赖图、缓存与动态 `import()`。不接受任意 URL、未声明依赖或运行时拼接的新模块；构建工具应输出上述固定名称。宿主不执行这些模块。

跨浏览器发布建议同时构建模块包。部分浏览器不能将 import map 的完整性信息用于严格 CSP；`code.moduleBundle` 使用同样经审核、固定哈希的单文件模块包，保留 SDK 的 `modules.import(path)` 调用方式。

```ts
import { bundleModules } from "@discourse-mini-app/sdk/pack";

const bundled = await bundleModules({ files: {
  "modules/game.mjs": gameSource,
  "modules/math.mjs": mathSource,
} });
// 将 bundled 写入项目 public/modules/bundle.mjs。
```

构建工具需要 Bun。`files` 的键与 `code.modules` 列表一致，包含全部依赖；内容为 JavaScript 字符串。支持列表内的相对导入和 `@mini-app/<路径>`，拒绝外部、未声明或无法确定目标的导入。构建不执行业务模块，禁用构建宏与宿主环境变量内联。

```json
{
  "permissions": ["code.modules"],
  "assets": ["modules/game.mjs", "modules/math.mjs", "modules/bundle.mjs"],
  "code": {
    "modules": ["modules/game.mjs", "modules/math.mjs"],
    "moduleBundle": "modules/bundle.mjs"
  }
}
```

声明 `moduleBundle` 后，各浏览器统一使用此文件；第一次导入会执行整个打包后的模块图，随后复用命名空间与实时导出绑定。它不是失败后重试另一份代码；模块包里的 `import.meta` 使用打包后的语义。需要互不关联的功能保持延迟执行时，将重操作放在导出函数中。模块包也可使用固定 CDN JavaScript，实际读取仍需 `assets.remote`；原始模块和模块包都属于提审内容。

## Worker

```ts
const worker = await sdk.workers.create("workers/sum.js", { name: "sum" });
worker.onmessage = ({ data }) => showResult(data);
worker.postMessage([1, 2, 3]);
// 不再使用时：worker.terminate();
```

Worker 为 classic 单文件脚本，返回原生 Worker，支持消息与 transferable buffer。业务代码在独立函数作用域运行，保留自身的严格模式与 hashbang；用 `self.onmessage` 或 `addEventListener` 注册消息处理，不依赖顶层函数声明自动成为全局事件处理器。Worker 内有只读的 `miniApp`，`miniApp.runtime` 为 `"worker"`。HTTP、流、SSE、WebSocket、存档和 Cookie 使用相同的 SDK 异步方法，并继承当前应用实际批准的权限和端点声明；浏览器原生独立联网、存储入口仍不可用。

```js
self.onmessage = async ({ data }) => {
  const response = await miniApp.http.request("lookup", { query: { key: data } });
  self.postMessage(response.body);
};
```

Worker 内可用 `miniApp.workers.create(path)` 创建已声明的子 Worker；返回可收发消息、终止的代理。父 Worker 终止或应用关闭时，子 Worker、请求和连接一并回收。原生 `new Worker()` 和 `importScripts()` 不作为加载入口。

需按需加载 Worker 库时，申请 `code.load` 与 `code.eval`，再用 `miniApp.scripts.load(path)`；库同样受固定执行角色和哈希约束，需通过 `globalThis` 显式导出，不依赖 Worker 业务代码的局部变量。普通 Worker 可直接将依赖打进单文件，无需该权限。

## 动态求值

确需运行时编译 JavaScript 的引擎可申请 `code.eval`，获批后在应用隔离环境及受控 Worker 中使用 `eval`、`new Function`。这个权限允许动态代码求值，须在提审时说明代码来源和用途；它不赋予父页面、论坛 Cookie、原生联网或设备访问权限。

可用 `sdk.capabilities.get()` 检测能力，并结合 `sdk.permissions.has()` 判断批准结果。浏览器不支持或策略禁止时处理 `BROWSER_UNSUPPORTED`；加载失败和取消不能视为成功。

原生 SharedWorker 跨文档共享、SharedArrayBuffer、多线程 WASM 与 AudioWorklet 仍受当前浏览器隔离条件限制；使用专用 Worker、消息传递和原生单线程 WebAssembly 降级，不通过同源 iframe 绕过隔离。

应用不能创建嵌套 iframe、frame、object、embed 或其他浏览上下文；不能用新窗口取得未受控的原生接口。页面内布局、Canvas、WebGL、Shadow DOM 和消息计算 Worker 仍可使用。
