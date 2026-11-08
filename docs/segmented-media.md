# 固定分片视频

`sdk.video.playSegments(source, options?)` 在平台播放器中播放固定的 fMP4 或 WebM 分片。`source` 包含带编码信息的 `mime`、初始化片路径 `init` 和按播放顺序排列的 `segments`。所有路径都必须在本版本的 `remote_assets` 中声明，并获批 `video.play` 与 `assets.remote`。

每片完整通过大小、MIME 和 SHA-256 校验后才进入播放器。播放器按播放进度预读；停止、取消加载、权限失效或关闭应用会清理下载和播放资源。不支持 MSE 或相应编码的浏览器返回 `BROWSER_UNSUPPORTED`，不会改用未经校验的视频地址。

## 准备 fMP4 文件

以下 FFmpeg 示例生成一个视频轨、独立初始化片和固定 HLS VOD 清单。编码参数按实际画质需求调整；`source.mime` 的 codecs 必须与输出一致。

```sh
mkdir -p out
ffmpeg -i input.mp4 -an \
  -vf 'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30' \
  -c:v libx264 -profile:v baseline -level:v 3.0 -pix_fmt yuv420p \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'out/part-%03d.m4s' out/movie.m3u8
```

HLS 转换器只整理固定路径，不转换视频编码或生成 hash。可在 Node 构建脚本中读取输出、计算真实 hash，并生成供应用导入的 `video-source.json`：

```js
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseHlsVod } from "@discourse-mini-app/sdk/media";

const source = parseHlsVod(await readFile("out/movie.m3u8", "utf8"), {
  mime: 'video/mp4; codecs="avc1.42C01E"', // 按实际输出填写
  resolvePath: (uri) => `movie/${uri}`,
});
const paths = [...new Set([source.init, ...source.segments])];
const remote_assets = Object.fromEntries(
  await Promise.all(
    paths.map(async (path) => {
      const filename = path.slice("movie/".length);
      const bytes = await readFile(`out/${filename}`);
      return [
        path,
        {
          url: new URL(filename, "https://cdn.example.com/movie/v1/").href,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          mime: "video/mp4",
        },
      ];
    })
  )
);
await writeFile("video-source.json", JSON.stringify(source));
await writeFile("remote-assets.json", JSON.stringify(remote_assets));
```

将生成的 `remote_assets` 合入 manifest，再上传完全相同的分片字节。CDN 需要允许论坛来源的 CORS 读取；返回的 Content-Type 应与各片声明一致，可用 `video/mp4`、`video/webm` 或 `application/octet-stream`。带 codecs 的 `source.mime` 描述解码格式，与每片 HTTP Content-Type 分开填写。

替换分片时重新计算 hash、更新声明并重新提交审核。清单 URI 会原样交给 `resolvePath`；包含查询参数、绝对地址或特殊文件名时，用明确的映射表解析，不要用去掉查询参数的方式猜测文件身份。转换器拒绝不安全的虚拟路径和不同 URI 映射到同一路径的歧义。

## 播放与停止

将生成的 JSON 作为应用构建输入导入：

```js
import source from "./video-source.json";

const { handle } = await sdk.video.playSegments(source, { volume: 0.7 });
// 在用户需要时进入画中画；平台会显示可信操作按钮。
await sdk.video.requestPictureInPicture(handle);
await sdk.video.stop(handle);
```

`options` 支持 `volume`、`signal` 和 `timeoutMs`，不含 `loop`。取消信号和显式超时覆盖取得播放句柄的加载阶段；取得句柄后使用 `video.stop(handle)` 停止持续播放。原有单文件 `video.play` 用法不变。

## DASH 转换

`parseDashVod(xml, { resolvePath, mime? })` 接受浏览器中的 XML 字符串，或调用方安全解析得到的 `Document`。字符串解析先拒绝 DTD 和实体声明，再使用浏览器 `DOMParser`；Node 环境没有内置 XML 解析器时，需要传入安全解析的 Document。转换器不会下载 XML、BaseURL、实体或分片。

```js
import { parseDashVod } from "@discourse-mini-app/sdk/media";

const paths = new Map([
  ["init.mp4", "movie/init.mp4"],
  ["part-000.m4s", "movie/part-000.m4s"],
]);
const source = parseDashVod(xmlText, {
  resolvePath(uri) {
    const path = paths.get(uri);
    if (!path) throw new Error(`未声明的分片：${uri}`);
    return path;
  },
});
```

DASH 默认从 Representation 或 AdaptationSet 的 `mimeType`、`codecs` 组合格式；缺少时用 `mime` 明确提供。

## 支持范围

| 清单 | 支持的固定子集                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| HLS  | 单个 `EXT-X-MAP`、逐片 `EXTINF` 与 URI、`EXT-X-ENDLIST`；可带版本、目标时长、媒体序号、VOD 类型和独立片段标记   |
| DASH | 静态单 Period、单 AdaptationSet、单 Representation；一个显式 SegmentList、一个 Initialization 和有序 SegmentURL |

HLS 加密、字节范围、主清单/变体、时间线不连续、直播与低延迟标签会被拒绝。DASH 动态清单、模板、BaseURL、加密、字节范围、时间偏移、多轨/多版本及其他未支持结构会被拒绝。支持 XML 内置转义，不支持自定义实体或处理指令。

这是固定分片顺序播放能力，包含已缓冲范围内的浏览器控制，不提供 ABR 码率切换、清单自动刷新或完整随机跳转索引。播放过的历史可能被浏览器回收；每片仍需完整校验，因此建议在制作时切成适合网络与设备内存的片段。
