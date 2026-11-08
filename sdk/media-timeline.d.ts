// Generated from sdk/src by tools/build-sdk.ts.
import { type MediaFragment, type MediaProgram } from "./media-program.js";
export interface MediaTimelineOptions {
    /** Resolve a playlist reference to an already approved fragment; this function never fetches it. */
    resolveFragment: (uri: string) => MediaFragment;
    /** Presentation time of the first listed segment; required for live HLS and duration-only dynamic DASH. */
    startTime?: number;
}
export interface HlsTimelineOptions extends MediaTimelineOptions {
    /** Required for a standalone media playlist; master playlists supply codecs and bandwidth. */
    mime?: string;
    bandwidth?: number;
    /** Use when a master cannot identify an external audio rendition's codec unambiguously. */
    mimeForPlaylist?: (uri: string, kind: "video" | "audio") => string | undefined;
    /** Explicit encoded timestamp adjustment, including every discontinuity boundary. */
    timestampOffset?: number | ((segment: {
        playlist: string;
        uri: string;
        sequence: number;
        discontinuity: number;
        start: number;
        duration: number;
    }) => number | undefined);
}
export interface DashTimelineOptions extends MediaTimelineOptions {
    /** Source MPD location for relative BaseURL/segment resolution; no request is made to this address. */
    baseUri?: string;
}
/** Convert already obtained HLS master/media texts into an explicit, resolver-pinned MSE timeline. */
export declare function parseHlsTimeline(playlists: ReadonlyMap<string, string>, entry: string, options: HlsTimelineOptions): MediaProgram;
/** Convert one explicit DASH Period; SegmentTimeline repeats are bounded by the supplied SegmentURL list. */
export declare function parseDashTimeline(document: Document, options: DashTimelineOptions): MediaProgram;
