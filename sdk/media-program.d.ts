// Generated from sdk/src by tools/build-sdk.ts.
/** A pinned file, or media bytes served by a separately approved business endpoint. */
export type MediaFragment = {
    path: string;
} | {
    endpoint: string;
    query?: Record<string, string>;
    sha256: string;
    size: number;
    mime: string;
};
export interface MediaTimelineSegment {
    id: string;
    start: number;
    duration: number;
    source: MediaFragment;
    /** Optional offset for discontinuous or rebased encoded timestamps. */
    timestampOffset?: number;
}
export interface MediaProgramTrack {
    id: string;
    mime: string;
    init: MediaFragment;
    segments: MediaTimelineSegment[];
    label?: string;
    language?: string;
}
export interface MediaProgramVariant {
    id: string;
    /** Bits per second used for automatic rendition selection. */
    bandwidth: number;
    video: MediaProgramTrack;
}
/** An explicit media timeline. Live indexes use the same shape with increasing sequence values. */
export interface MediaProgram {
    variants: MediaProgramVariant[];
    audioTracks?: MediaProgramTrack[];
    duration?: number;
    live?: boolean;
    ended?: boolean;
    sequence?: number;
    /** Polling advice for a live index, in milliseconds. */
    updateIntervalMs?: number;
}
export type MediaProgramSource = {
    program: MediaProgram;
} | {
    playlist: {
        endpoint: string;
        query?: Record<string, string>;
    };
};
export interface MediaProgramState {
    currentTime: number;
    duration: number | null;
    live: boolean;
    variant: string;
    selection: "auto" | "manual";
    audioTrack: string | null;
    available: {
        start: number;
        end: number;
    };
}
export declare function validateMediaFragment(value: unknown): MediaFragment;
/** Validate and detach a timeline before it enters the trusted playback controller. */
export declare function validateMediaProgram(value: unknown): MediaProgram;
export declare function validateMediaProgramSource(value: unknown): MediaProgramSource;
