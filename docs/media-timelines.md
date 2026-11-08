# 高级视频时间线与直播

## MediaProgram 与播放

所有视频播放和控制需要 `video.play`。节目中的 `path` 指向包内文件或 `remote_assets`：后者另需 `assets.remote`，并使用 manifest 固定的 SHA-256、大小和 MIME。

通过业务端点取得媒体段或 JSON 直播索引时，还需 `video.stream` 和 `network.request`。这些端点必须在 manifest 中声明为 GET；query 键也必须预先声明。受保护端点继续要求 `user.read` 和登录，匿名只能使用获批的公开端点。

```ts
const program = {
  variants: [
    {
      id: "720p",
      bandwidth: 1800000,
      video: {
        id: "main-video",
        mime: 'video/mp4; codecs="avc1.42E01E"',
        init: { path: "movie/init.mp4" },
        segments: [
          {
            id: "segment-1",
            start: 0,
            duration: 4,
            source: { path: "movie/one.m4s" },
          },
        ],
      },
    },
  ],
  duration: 4,
};
const { handle } = await sdk.video.playProgram(
  { program },
  {
    volume: 0.8,
    bufferAhead: 30,
  }
);
```

`variants` 是可供切换的视频档位列表，每档包含稳定的 `id`、以 bit/s 表示的 `bandwidth` 和一条 `video` 轨道。轨道含 `id`、带 codecs 的 MP4/WebM MIME、`init` 初始化段，以及按时间排序的 `segments`。每段含 `id`、非负 `start`、正数 `duration`、`source`，必要时提供 `timestampOffset`。展示时间须与编码时间戳一致。

`audioTracks` 可提供独立音轨，结构与 video 轨道相同，但 MIME 使用 audio/mp4 或 audio/webm，并可设置 `label`、`language`。每条可选音轨必须覆盖视频可播放窗口，不能有未支持的缺失区间；编码边界允许 0.1 秒误差。不同视频档位也要覆盖同一个时间窗口。编码器是否可用由当前浏览器判断。音轨应在初始节目中列出；已按纯视频初始化或移除全部音轨后，新增音频拓扑可能不受浏览器支持，此时 `updateProgram` 返回 `BROWSER_UNSUPPORTED` 并保留现有节目，需要重新开始播放带音轨的节目。

除 `{ path }` 外，初始化段和媒体段还可使用：

```ts
{
  endpoint: "videoFragment",
  query: { id: "segment-1" },
  sha256: "实际片段字节的64位小写SHA-256",
  size: 123456,
  mime: "video/mp4",
}
```

这不是 URL 参数。端点地址固定在审核过的 manifest 中。每段完整接收后，先核对实际解码后字节数、响应 MIME 和 SHA-256，再送入播放；校验失败不会以未校验内容回退。业务索引中的 hash 绑定该索引声明的媒体内容，不替代固定 `remote_assets` 清单的审核。

```ts
const state = await sdk.video.state(handle);
await sdk.video.seek(handle, 2);
await sdk.video.setVariant(handle, "720p");
await sdk.video.setVariant(handle, "auto");
// 存在独立音轨时，使用对应 audioTracks[].id：
await sdk.video.selectAudioTrack(handle, "audio-zh");
await sdk.video.stop(handle);
```

高级节目状态返回 `currentTime`、`duration`、`live`、`variant`、`selection`、`audioTrack` 和 `available: { start, end }`。直播尚未结束时 duration 为 null。seek 目标须在当前可用窗口内；`auto` 使用传输估计选择档位，也可手动指定已声明且浏览器支持的档位。切换/seek 会重新取得所需初始化段和媒体段，不能绕过原有素材或端点权限。

## 直播更新

直播节目设置 `live: true`，可提供非负整数 `sequence` 和正数 `updateIntervalMs`。索引只能前进；sequence 不能倒退，同一轨道中已经出现的段 ID 不得更改 start、duration、source 或 timestampOffset。窗口可以移走旧段并加入新段；当前位置落在窗口之前时会移动到新的窗口起点。结束时提交最终窗口并设置 `ended: true`。

应用自行通过 HTTP/WS 取得新节目时调用：

```ts
await sdk.video.updateProgram(handle, nextProgram);
```

或者声明一个返回 MediaProgram JSON 的 GET 端点，让播放器刷新索引：

```ts
const { handle } = await sdk.video.playProgram({
  playlist: { endpoint: "liveIndex", query: { room: "demo" } },
});
```

这个 JSON 端点需要与媒体段相同的 `video.stream`、`network.request` 授权。`updateIntervalMs` 是索引的轮询建议；不设置默认使用播放器策略。停止、取消、卸载或权限失效会释放播放和正在等待的读取。普通 `video.play` 的 state/seek 返回较小的状态结构；多档位、多音轨与 updateProgram 仅用于高级节目。

## 清单转换

`parseHlsTimeline` 和 `parseDashTimeline` 把应用已经取得的清单转换为 `MediaProgram`。函数不请求网络；每个初始化段和媒体段都必须经 `resolveFragment(uri)` 映射到已声明的素材路径，或带 SHA-256、大小、MIME 的已审核业务端点。不能把任意媒体 URL 直接交给播放器。

结果可传给 `video.playProgram({ program })`。内联直播节目由应用取得后续清单，再通过 `video.updateProgram(handle, program)` 更新；使用 JSON playlist 端点的节目由播放器按该接口约定刷新。

## HLS

```ts
import { parseHlsTimeline } from "@discourse-mini-app/sdk/timeline";

const program = parseHlsTimeline(playlists, "master.m3u8", {
  resolveFragment: (uri) => {
    const fragment = approvedFragments.get(uri);
    if (!fragment) throw new Error("未声明的素材");
    return fragment;
  },
});
```

`playlists` 是 `ReadonlyMap<string, string>`，包含主清单及所有被引用的媒体清单文本。相对 URI 按所在清单解析；缺少子清单时直接报错，不自动下载。

支持带 `BANDWIDTH`、`CODECS` 的多档主清单、外置音频组及语言标签。默认音轨优先使用 `DEFAULT=YES`。只有一个媒体清单时，需要另外传 `mime` 和 `bandwidth`。当主清单无法唯一确定某条外置音频的编码时，使用 `mimeForPlaylist(uri, kind)` 明确提供 MIME。

媒体清单使用 `EXT-X-MAP` 初始化段和 `EXTINF` 时长。每段 ID 保留媒体序号，时间线从 `startTime` 累加；媒体序号不是时间，不能用序号乘某一段时长推算。没有 `ENDLIST` 的清单作为直播处理，必须显式提供第一段的展示时间 `startTime`。

`timestampOffset` 可为常量，或接收 `{ playlist, uri, sequence, discontinuity, start, duration }` 的回调。在每个不连续边界以及带非零 discontinuity sequence 的首段，必须给出明确偏移；无法确定时拒绝转换。偏移应来自编码器/媒体时钟信息，转换器不会读取媒体比特流来猜测时间戳。

此入口面向可独立追加的 fMP4 段。一个轨道只能有一个初始化 MAP；范围寻址、变化的 MAP、加密/DRM、低延迟 HLS 部分段和未支持的标签会被拒绝。它不承诺支持所有 HLS 变体。[HLS 格式规范](https://www.rfc-editor.org/rfc/rfc8216)

## DASH

```ts
import { parseDashTimeline } from "@discourse-mini-app/sdk/timeline";

const program = parseDashTimeline(parsedMpdDocument, {
  baseUri: "https://media.example/manifest.mpd",
  resolveFragment: (uri) => {
    const fragment = approvedFragments.get(uri);
    if (!fragment) throw new Error("未声明的素材");
    return fragment;
  },
});
```

输入为已安全解析的 XML `Document`，不接受 DTD、实体、处理指令、xlink、DRM 或外部文档引用。`baseUri` 仅用于解析相对地址，不会产生请求。

支持一个 Period 中的多 Representation、独立音频 AdaptationSet 和语言标签。Representation 需有明确 ID、MIME、codecs，视频还需有 bandwidth。支持继承的显式 SegmentList、Initialization、SegmentURL、timescale、presentationTimeOffset，以及固定 duration 或 SegmentTimeline。

SegmentTimeline 的重复次数始终受清单中实际 SegmentURL 数量约束；`r=-1` 也不会无限展开。动态 MPD 作为直播节目处理；若没有明确的首个 `S@t`，或只使用 duration，需要调用方提供 `startTime`。这些转换只处理当前显式列出的片段，不是基于 UTC 时钟的片段可用性调度器。[DASH 时间模型说明](https://dashif.org/Guidelines-TimingModel/)

SegmentTemplate、字节范围寻址、多 Period 自动拼接及未支持的结构会被拒绝。输出仍要通过 `MediaProgram` 时间线校验；音轨必须覆盖可播放的视频时间窗，播放器还会检查当前浏览器是否支持相应编码。
