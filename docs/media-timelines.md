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

`variants` 是可供切换的视频档位列表，每档包含稳定的 `id`、以 bit/s 表示的 `bandwidth` 和一条 `video` 轨道。轨道含 `id`、带 codecs 的 MP4/WebM MIME、`init` 初始化段，以及按时间排序的 `segments`。每段含 `id`、非负 `start`、正数 `duration`、`source`，必要时提供 `timestampOffset`。段上的 `init` 可覆盖轨道初始化段；没有提供时使用 `track.init`，不会沿用上一段的覆盖值。展示时间须与编码时间戳一致。

DASH Period 等明确裁剪边界可使用 `segment.appendWindow: { start, end }`。它以展示时间表示整个 Period 的保留范围，播放器与节目可用窗口求交后再追加该段；它不是将每个音频包强行裁到名义分片时长。切换初始化段不会自动允许变更轨道的容器或 codecs。

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

同一已审核文件中的子区间可表示为 `{ path: "movie.mp4", range: { offset: 1024, length: 4096 } }`；端点形式也可带 `range`。offset 为非负安全整数，length 为正安全整数，区间不得溢出或超出原始内容。播放器验证完整源文件／响应后才切片，**不会把未校验的 HTTP Range 响应当成原文件**，也不会自动增加 Range 请求头。

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

WebM 音频跳转时会按初始化段的 `SeekPreRoll` 预加载前置音频分片。直播索引应保留足够且连续的前置数据；播放器只使用已声明片段，不会自行构造窗口外的素材地址。没有声明 `SeekPreRoll` 时按 0 处理。

## 直播更新

直播节目设置 `live: true`，可提供非负整数 `sequence` 和正数 `updateIntervalMs`。索引只能前进；sequence 不能倒退，同一轨道中已经出现的段 ID 不得更改时间、source、初始化段或裁剪窗。窗口可以移走旧段并加入新段；当前位置落在窗口之前时会移动到新的窗口起点。结束时提交最终窗口并设置 `ended: true`。

当前音轨被移除时，会立即切换到仍可用的音轨；没有可用音轨则停止该音轨。即使没有新增视频段，也会保留播放位置并应用这次变化。

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

## WebVTT 字幕

`textTracks` 中每条轨道使用 `{ id, mime: "text/vtt", label?, language? }`，并二选一提供整文件 `source`（可带 `timestampOffset`），或 `segments: [{ id, start, duration, source, timestampOffset? }]`。来源沿用相同素材／端点权限和完整性校验。直播的字幕段列表可暂时为空。

```ts
await sdk.video.selectTextTrack(handle, program.textTracks[0].id);
await sdk.video.selectTextTrack(handle, null); // 关闭字幕
```

状态中的 `textTrack` 表示当前选择，`textTrackError` 表示直播字幕刷新失败；失败或取消保留原字幕，不停止视频。支持基础 WebVTT cue 及原生行、位置、对齐设置；不执行字幕 HTML，也不支持 `STYLE`／`REGION` 块。

存在 `X-TIMESTAMP-MAP` 时必须显式提供 `timestampOffset`（可为 0）：展示时间按 `(cue - LOCAL + MPEGTS / 90000) + timestampOffset` 转换，再裁到字幕段窗口。MPEGTS 必须在 33 位范围内；不会猜测回绕次数、视频时钟或 UTC 对齐。

## 清单转换

`parseHlsTimeline` 和 `parseDashTimeline` 把应用已经取得的清单转换为 `MediaProgram`。函数不请求网络；每个初始化段、媒体段和字幕段都必须经 `resolveFragment(uri, requestedRange?)` 映射到已声明的素材路径，或带 SHA-256、大小、MIME 的已审核业务端点。不能把任意媒体 URL 直接交给播放器。

普通 resolver 返回完整源的 `{ path }` 或端点声明即可：转换器会附上清单的 range。如果业务端点已经按独立 SHA-256 返回所需片段，resolver 可根据第二参选取该响应，并显式返回 `range: { offset: 0, length: 片段字节数 }`；此时以 resolver 给出的 range 为准，不再对片段使用原文件偏移。所有范围仍由播放器核验。

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

支持带 `BANDWIDTH`、`CODECS` 的多档主清单、外置音频组、`SUBTITLES` WebVTT 组及语言标签。默认 rendition 优先排列 `DEFAULT=YES`。只有一个媒体清单时，需要另外传 `mime` 和 `bandwidth`。当主清单无法唯一确定某条外置音频的编码时，使用 `mimeForPlaylist(uri, kind)` 明确提供 MIME。

媒体清单使用 `EXT-X-MAP` 初始化段和 `EXTINF` 时长。每段 ID 保留媒体序号，时间线从 `startTime` 累加；媒体序号不是时间，不能用序号乘某一段时长推算。没有 `ENDLIST` 的清单作为直播处理，必须显式提供第一段的展示时间 `startTime`。

`timestampOffset` 可为常量，或接收 `{ playlist, uri, sequence, discontinuity, start, duration }` 的回调。在每个不连续边界以及带非零 discontinuity sequence 的首段，必须给出明确偏移；无法确定时拒绝转换。偏移应来自编码器/媒体时钟信息，转换器不会读取媒体比特流来猜测时间戳。

支持 `EXT-X-BYTERANGE` 和 MAP 的 `BYTERANGE`。省略 offset 时，必须存在同一资源的前一媒体段范围，才可从其末尾继续；不会假定从 0 开始。MAP 可在轨道内变化，转换器为每段保留当时的初始化源，滑动窗口不会丢失映射。

字幕清单不要求 MAP，但每段必须包含自己的 WebVTT 头；拆分字幕头的 MAP 形式会被明确拒绝。字幕沿用 `timestampOffset` 回调，正文含 `X-TIMESTAMP-MAP` 而没有明确映射时，播放器拒绝该字幕并保留原选择。

此入口面向可独立追加的 fMP4 段，不做 MPEG-TS 转封装。加密/DRM、低延迟 HLS 部分段、内嵌 closed captions 和未支持的标签仍会被拒绝。它不承诺支持所有 HLS 变体。[HLS 格式规范](https://www.rfc-editor.org/rfc/rfc8216)

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

支持多 Representation、独立音频 AdaptationSet 和语言标签。Representation 需有明确 ID、MIME、codecs，视频还需有 bandwidth。支持继承的 SegmentList 或 SegmentTemplate、Initialization、SegmentURL、timescale、presentationTimeOffset，以及固定 duration 或 SegmentTimeline。Initialization 的 `range`、SegmentURL 的 `mediaRange` 按闭区间转换；未给 URL 时使用已解析的 BaseURL。

SegmentTemplate 支持 `$RepresentationID$`、`$Bandwidth$`、`$Number$`、`$Time$`、`$$` 和数字零填充（如 `$Number%05d$`）。媒体模板须含 Number 或 Time；初始化模板不得随 Number／Time 变化。duration 模式支持 `eptDelta`，显式 SegmentTimeline 则使用其自身时间戳。未知变量或无法唯一展开的模板会被拒绝。

SegmentList 的重复次数受实际 URL 数量约束。模板中的 `r=-1` 须由下一明确 `S@t`、Period 终点、`endNumber` 或调用方的有限 `endTime` 限定；duration 模板也必须有可计算的终点。动态 duration 模式仍需显式 `startTime`。`{ startTime, endTime }` 用展示秒选择重叠的完整片段，不以窗口边缘改写已发布段的边界；仅真正的 Period 边界会裁剪。不会根据 UTC 猜测尚未发布的片段。[DASH 时间模型说明](https://dashif.org/Guidelines-TimingModel/)

多个 Period 须连续、无歧义，且保持稳定的 AdaptationSet／Representation 身份、轨道集合、容器与 codecs。转换器拼接时间线，为每段保留对应初始化源、PTO 偏移和 Period 裁剪窗；段 ID 含 Period 身份以免序号重启冲突。同一档位跨 Period 的 bandwidth 使用最大值。大于 0.1 秒的媒体空缺、codec 变化或不明确的轨道对应关系会被拒绝。

直播生产端应在发布片段时固定其 Period 边界；事后新增／改变旧段裁剪窗仍可能违反不可变时间线规则，更新失败会保留现有节目。DRM、SegmentBase 索引寻址、外部文档及未支持的结构仍不开放。输出继续通过 `MediaProgram` 校验，音轨必须覆盖视频窗口，实际解码能力由当前浏览器决定。
