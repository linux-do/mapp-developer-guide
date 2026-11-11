import type {
  CaptureKind,
  CaptureSnapshot,
  MiniAppSDK,
  MiniAppSocket,
  Permission,
  RequestOptions,
  StorageSnapshot,
} from "@discourse-mini-app/sdk";
import type { MiniAppManifest } from "@discourse-mini-app/sdk/pack";
import type { RunOptions } from "./state.ts";
import { parseJsonInput, safeCode } from "./state.ts";

type Run = <T>(
  operation: string,
  action: () => T | Promise<T>,
  after?: ((value: T) => unknown) | null,
  options?: RunOptions<T>
) => Promise<void>;

const failure = (code: string) => Object.assign(new Error(code), { code });
const input = (id: string) =>
  document.getElementById(id) as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
const text = (id: string) => input(id).value.trim();
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Optional services stay idle until a reviewed declaration and a user action exist. */
export function createExtendedSamples({
  getSDK,
  manifest,
  run,
  show,
  t,
  getVideo,
  setVideo,
  getSocket,
}: {
  getSDK: () => MiniAppSDK;
  manifest: Pick<
    MiniAppManifest,
    | "id"
    | "calls"
    | "links"
    | "devices"
    | "endpoints"
    | "websockets"
    | "remote_assets"
  >;
  run: Run;
  show: (id: string, value: unknown) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  getVideo: () => string | null | undefined;
  setVideo: (handle: string | null) => void;
  getSocket: () => MiniAppSocket | null | undefined;
}) {
  let disposed = false;
  let scope = new AbortController();
  let worker: Worker | undefined;
  type WorkletSession = {
    context: AudioContext;
    control: AbortController;
    node?: AudioWorkletNode;
    timer?: ReturnType<typeof setTimeout>;
  };
  let worklet: WorkletSession | undefined;
  let capture: CaptureSnapshot | undefined;
  let captureRequest: symbol | undefined;
  let captureControl: AbortController | undefined;
  let recordingReadRequest: symbol | undefined;
  let recordingFinishRequest: symbol | undefined;
  let imageURL: string | undefined;
  let recording: Blob | undefined;
  let readChunks: Uint8Array<ArrayBuffer>[] = [];
  let programHandle: string | undefined;
  let usb: string | undefined;
  let bluetooth: string | undefined;
  let recovery:
    | ReturnType<MiniAppSDK["network"]["reconnectSocket"]>
    | undefined;
  let uploadId = crypto.randomUUID();
  const uploadChanged = () => {
    uploadId = crypto.randomUUID();
    input("upload-offset").value = "0";
  };
  input("upload-file").addEventListener("change", uploadChanged);
  const readers = new Set<{ cancel(): Promise<void> }>();

  const write = (id: string, value: unknown) => {
    if (!disposed) {
      show(id, value);
    }
  };
  const options = (): RequestOptions => ({ signal: scope.signal });
  const client = (permission?: Permission) => {
    if (disposed) {
      throw failure("APP_UNLOADED");
    }
    const sdk = getSDK();
    if (permission && !sdk.permissions.has(permission)) {
      throw failure("PERMISSION_DENIED");
    }
    return sdk;
  };
  const endpoint = (id: string) => {
    const name = text(id);
    if (!Object.hasOwn(manifest.endpoints || {}, name)) {
      throw failure("NOT_CONFIGURED");
    }
    return name;
  };
  const file = (id: string) => {
    const field = input(id);
    const value =
      field instanceof HTMLInputElement ? field.files?.[0] : undefined;
    if (!value) {
      throw failure("INVALID_ARGUMENTS");
    }
    return value;
  };
  async function acquire<T>(
    create: (settings: RequestOptions) => Promise<T>,
    release: (value: T) => unknown | Promise<unknown>,
    retain: (value: T) => void,
    signal = scope.signal
  ) {
    const value = await create({ signal });
    if (signal.aborted || disposed) {
      try {
        await release(value);
      } catch {}
      throw failure("CANCELLED");
    }
    retain(value);
    return value;
  }
  function message<T>(
    target: EventTarget,
    signal: AbortSignal,
    send: () => void,
    accept: (value: unknown) => T
  ) {
    return new Promise<T>((resolve, reject) => {
      const clear = () => {
        target.removeEventListener("message", receive);
        target.removeEventListener("messageerror", failed);
        target.removeEventListener("error", failed);
        signal.removeEventListener("abort", abort);
      };
      const receive = (event: Event) => {
        clear();
        try {
          resolve(accept((event as MessageEvent<unknown>).data));
        } catch (error) {
          reject(error);
        }
      };
      const failed = () => {
        clear();
        reject(failure("REQUEST_FAILED"));
      };
      const abort = () => {
        clear();
        reject(signal.reason);
      };
      target.addEventListener("message", receive);
      target.addEventListener("messageerror", failed);
      target.addEventListener("error", failed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        send();
      } catch (error) {
        clear();
        reject(error);
      }
    });
  }
  async function stopWorklet(session = worklet) {
    if (!session) {
      return;
    }
    if (worklet === session) {
      worklet = undefined;
    }
    session.control.abort(failure("CANCELLED"));
    clearTimeout(session.timer);
    session.node?.disconnect();
    session.node?.port.close();
    if (session.context.state !== "closed") {
      await session.context.close();
    }
  }
  async function stopCapture() {
    captureControl?.abort(failure("CANCELLED"));
    captureControl = undefined;
    captureRequest = undefined;
    recordingReadRequest = undefined;
    recordingFinishRequest = undefined;
    const current = capture;
    capture = undefined;
    if (current) {
      await getSDK()
        .media.stop(current.handle)
        .catch(() => {});
    }
  }
  async function startCapture(kind: CaptureKind) {
    const sdk = client(kind === "screen" ? "screen.capture" : kind);
    if (typeof sdk.media?.capture !== "function") {
      throw failure("API_UNSUPPORTED");
    }
    if (capture || captureRequest) {
      throw failure("BUSY");
    }
    const request = Symbol();
    captureRequest = request;
    const control = new AbortController();
    captureControl = control;
    const signal = AbortSignal.any([scope.signal, control.signal]);
    try {
      const value = await acquire(
        (settings) =>
          sdk.media.capture(kind, {
            ...settings,
            record: kind === "microphone",
            ...(kind === "microphone" ? {} : { audio: false }),
          }),
        (resource) => sdk.media.stop(resource.handle),
        (resource) => {
          capture = resource;
          readChunks = [];
          recording = undefined;
        },
        signal
      );
      return {
        kind: value.kind,
        mime: value.mime,
        tracks: value.tracks.map((track) => ({
          kind: track.kind,
          enabled: track.enabled,
        })),
      };
    } finally {
      if (captureRequest === request) {
        captureRequest = undefined;
      }
    }
  }
  async function consume(
    endpointId: string,
    events: boolean,
    reconnect = false
  ) {
    const sdk = client("network.request");
    const name = endpoint(endpointId);
    const signal = scope.signal;
    let close: (() => Promise<void>) | undefined;
    let body: ReadableStream<unknown>;
    if (reconnect) {
      const connection = sdk.network.reconnectEvents(name, {
        signal,
        lastEventIdQuery: text("event-cursor") || "cursor",
      });
      close = () => connection.close();
      void connection.done.catch(() => {});
      body = connection.body;
    } else {
      const response = events
        ? await sdk.http.events(name, { signal })
        : await sdk.http.stream(name, { signal });
      body = response.body;
    }
    const reader = body.getReader();
    readers.add(reader);
    let count = 0;
    let size = 0;
    let preview = "";
    let updated = 0;
    const decoder = new TextDecoder();
    let done = false;
    try {
      while (!done) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        done = next.done;
        if (done) {
          break;
        }
        count++;
        if (events) {
          preview = JSON.stringify(next.value).slice(0, 4096);
        } else if (next.value instanceof Uint8Array) {
          size += next.value.byteLength;
          if (preview.length < 4096) {
            preview += decoder
              .decode(next.value, { stream: true })
              .slice(0, 4096 - preview.length);
          }
        }
        if (performance.now() - updated >= 100) {
          updated = performance.now();
          write("transfer-output", { received: count, bytes: size, preview });
        }
      }
      return { received: count, bytes: size, preview };
    } finally {
      readers.delete(reader);
      if (!done) {
        await reader.cancel().catch(() => {});
      }
      reader.releaseLock();
      await close?.().catch(() => {});
    }
  }
  const outputs: Record<string, string> = {
    support: "support-output",
    scriptRun: "execution-output",
    moduleRun: "execution-output",
    workerRun: "execution-output",
    evalRun: "execution-output",
    remoteRead: "execution-output",
    workletStart: "worklet-output",
    workletStop: "worklet-output",
    videoFormats: "program-output",
    videoState: "program-output",
    videoSeek: "program-output",
    videoProgram: "program-output",
    videoVariant: "program-output",
    videoAudio: "program-output",
    videoText: "program-output",
    videoUpdate: "program-output",
    programStop: "program-output",
    pictureEnter: "program-output",
    pictureExit: "program-output",
    linkOpen: "browser-output",
    saveFile: "browser-output",
    share: "browser-output",
    wakeOn: "browser-output",
    wakeOff: "browser-output",
    gamepads: "browser-output",
    storageExport: "backup-output",
    storageImport: "backup-output",
    camera: "capture-output",
    microphone: "capture-output",
    screenCapture: "capture-output",
    captureFrame: "capture-output",
    recordingRead: "capture-output",
    recordingFinish: "capture-output",
    captureStop: "capture-output",
    recordingSave: "capture-output",
    locate: "device-output",
    usbOpen: "device-output",
    usbClose: "device-output",
    bluetoothOpen: "device-output",
    bluetoothClose: "device-output",
    notifyFrontend: "notification-output",
    notifyBackend: "notification-output",
    appCall: "app-output",
    appReturn: "app-output",
    httpStream: "transfer-output",
    httpEvents: "transfer-output",
    eventRecover: "transfer-output",
    uploadFile: "transfer-output",
    uploadChunks: "transfer-output",
    socketRecover: "transfer-output",
    socketRecoverClose: "transfer-output",
    socketText: "socket-output",
    socketBinary: "socket-output",
    extendedCancel: "transfer-output",
  };
  const execute = <T>(
    id: string,
    action: () => T | Promise<T>,
    discard?: (value: T) => unknown | Promise<unknown>
  ) => {
    const signal = scope.signal;
    return run(
      id,
      async () => {
        const value = await action();
        signal.throwIfAborted();
        return value;
      },
      (value) => write(outputs[id]!, value),
      { onDiscard: discard }
    );
  };
  const video = () => {
    const handle = getVideo();
    if (!handle) {
      throw failure("NOT_PLAYING");
    }
    return handle;
  };
  const actions: Record<string, () => Promise<void>> = {
    support: () =>
      execute("support", () => client().capabilities.get(options())),
    scriptRun: () =>
      execute("scriptRun", async () => {
        await client("code.load").scripts.load("chunks/sample.js");
        const value: unknown = Reflect.get(globalThis, "capabilityChunk");
        if (!object(value) || value.answer !== 42) {
          throw failure("SCRIPT_RESULT_MISMATCH");
        }
        return { answer: value.answer };
      }),
    moduleRun: () =>
      execute("moduleRun", async () => {
        const module =
          await client("code.modules").modules.import("modules/sample.mjs");
        if (typeof module.answer !== "function") {
          throw failure("MODULE_EXPORT_MISSING");
        }
        const answer: unknown = module.answer();
        if (answer !== 42) {
          throw failure("MODULE_RESULT_MISMATCH");
        }
        return { answer };
      }),
    workerRun: () =>
      execute("workerRun", async () => {
        const signal = scope.signal;
        const current = await acquire(
          (settings) =>
            client("workers.create").workers.create("workers/sum.js", {
              ...settings,
              name: "capability-sum",
            }),
          (value) => value.terminate(),
          (value) => {
            worker = value;
          }
        );
        try {
          const payload = new Float64Array([1, 2, 3, 4]);
          return await message(
            current,
            signal,
            () => {
              current.postMessage(payload, [payload.buffer]);
              if (payload.byteLength !== 0) {
                throw failure("WORKER_TRANSFER_FAILED");
              }
            },
            (value) => {
              if (!object(value) || value.sum !== 10) {
                throw failure("WORKER_RESULT_MISMATCH");
              }
              return { sum: value.sum, transferred: payload.byteLength === 0 };
            }
          );
        } finally {
          current.terminate();
          if (worker === current) {
            worker = undefined;
          }
        }
      }),
    evalRun: () =>
      execute("evalRun", () => {
        client("code.eval");
        const answer: unknown = new Function("return 6 * 7")();
        if (answer !== 42) {
          throw failure("EVAL_RESULT_MISMATCH");
        }
        return { answer };
      }),
    remoteRead: () =>
      execute("remoteRead", async () => {
        const path = text("remote-path");
        if (!Object.hasOwn(manifest.remote_assets || {}, path)) {
          throw failure("NOT_CONFIGURED");
        }
        const value = await client("assets.remote").assets.readBytes(
          path,
          options()
        );
        return {
          bytes: value.byteLength,
          preview: Array.from(value.subarray(0, 32)),
        };
      }),
    workletStart: () =>
      execute("workletStart", async () => {
        const sdk = client("audio.worklet");
        client("audio.webAudio");
        if (worklet) {
          throw failure("BUSY");
        }
        if (
          typeof AudioContext !== "function" ||
          typeof AudioWorkletNode !== "function" ||
          typeof sdk.audioWorklet?.addModule !== "function"
        ) {
          throw failure("BROWSER_UNSUPPORTED");
        }
        const control = new AbortController();
        const signal = AbortSignal.any([scope.signal, control.signal]);
        const context = new AudioContext();
        const session: WorkletSession = { context, control };
        worklet = session;
        const resumed = context.resume();
        void resumed.catch(() => {});
        try {
          await Promise.all([
            resumed,
            sdk.audioWorklet.addModule(context, "audio/tone.js", { signal }),
          ]);
          signal.throwIfAborted();
          const node = new AudioWorkletNode(context, "capability-tone");
          session.node = node;
          node.addEventListener(
            "processorerror",
            () => control.abort(failure("PROCESSOR_ERROR")),
            { once: true }
          );
          await message(
            node.port,
            signal,
            () => {
              node.port.start();
              node.connect(context.destination);
            },
            (value) => {
              if (!object(value) || value.ready !== true) {
                throw failure("WORKLET_RESULT_MISMATCH");
              }
              return value;
            }
          );
          session.timer = setTimeout(() => {
            if (worklet === session) {
              void stopWorklet(session);
              write("worklet-output", t("workletEnded"));
            }
          }, 5000);
          return {
            context: context.state,
            processor: "capability-tone",
            processed: true,
          };
        } catch (error) {
          await stopWorklet(session);
          throw error;
        }
      }),
    workletStop: () =>
      execute("workletStop", async () => {
        await stopWorklet();
        return { stopped: true };
      }),
    videoFormats: () =>
      execute("videoFormats", () => {
        const probe = document.createElement("video");
        return [
          'video/mp4; codecs="avc1.42E01E"',
          'video/webm; codecs="vp8"',
          'video/webm; codecs="vp9"',
          'video/ogg; codecs="theora"',
        ].map((mime) => ({
          mime,
          playback: probe.canPlayType(mime),
          mse:
            typeof MediaSource === "function" &&
            typeof MediaSource.isTypeSupported === "function"
              ? MediaSource.isTypeSupported(mime)
              : null,
        }));
      }),
    videoState: () =>
      execute("videoState", () =>
        client("video.play").video.state(video(), options())
      ),
    videoSeek: () =>
      execute("videoSeek", () =>
        client("video.play").video.seek(
          video(),
          Number(text("video-time")),
          options()
        )
      ),
    videoProgram: () =>
      execute("videoProgram", async () => {
        if (getVideo()) {
          throw failure("BUSY");
        }
        const source = parseJsonInput(input("video-source").value);
        if (
          object(source) &&
          object(source.playlist) &&
          typeof source.playlist.endpoint === "string" &&
          !Object.hasOwn(manifest.endpoints || {}, source.playlist.endpoint)
        ) {
          throw failure("NOT_CONFIGURED");
        }
        await acquire(
          (settings) =>
            client("video.stream").video.playProgram(
              source as unknown as Parameters<
                MiniAppSDK["video"]["playProgram"]
              >[0],
              settings
            ),
          (value) => getSDK().video.stop(value.handle),
          (value) => {
            programHandle = value.handle;
            setVideo(value.handle);
          }
        );
        return { playing: true };
      }),
    videoVariant: () =>
      execute("videoVariant", () =>
        client("video.stream").video.setVariant(
          video(),
          text("video-choice") || "auto",
          options()
        )
      ),
    videoAudio: () =>
      execute("videoAudio", () =>
        client("video.stream").video.selectAudioTrack(
          video(),
          text("video-choice"),
          options()
        )
      ),
    videoText: () =>
      execute("videoText", () =>
        client("video.stream").video.selectTextTrack(
          video(),
          text("video-choice") || null,
          options()
        )
      ),
    videoUpdate: () =>
      execute("videoUpdate", () => {
        const source = parseJsonInput(input("video-source").value);
        const program =
          object(source) && object(source.program) ? source.program : source;
        return client("video.stream").video.updateProgram(
          video(),
          program as unknown as Parameters<
            MiniAppSDK["video"]["updateProgram"]
          >[1],
          options()
        );
      }),
    programStop: () =>
      execute("programStop", async () => {
        const handle = video();
        await client("video.play").video.stop(handle);
        if (getVideo() === handle) {
          setVideo(null);
        }
        if (programHandle === handle) {
          programHandle = undefined;
        }
        return { stopped: true };
      }),
    pictureEnter: () =>
      execute("pictureEnter", () =>
        client("video.play").video.requestPictureInPicture(video(), options())
      ),
    pictureExit: () =>
      execute("pictureExit", () =>
        client("video.play").video.exitPictureInPicture()
      ),
    linkOpen: () =>
      execute("linkOpen", () => {
        const url = text("link-target");
        if (!manifest.links?.includes(url)) {
          throw failure("NOT_CONFIGURED");
        }
        return client("links.open").links.open(url, options());
      }),
    saveFile: () =>
      execute("saveFile", () =>
        client("files.save").files.save(
          "capability-sample.json",
          JSON.stringify({ sample: true, answer: 42 }),
          options()
        )
      ),
    share: () =>
      execute("share", () =>
        client("sharing.share").sharing.share(
          { title: t("title"), text: t("shareSample") },
          options()
        )
      ),
    wakeOn: () =>
      execute(
        "wakeOn",
        () => client("screen.keepAwake").screen.setKeepAwake(true, options()),
        () => getSDK().screen.setKeepAwake(false)
      ),
    wakeOff: () =>
      execute("wakeOff", () =>
        client("screen.keepAwake").screen.setKeepAwake(false, options())
      ),
    gamepads: () =>
      execute("gamepads", () =>
        client("gamepad.read")
          .gamepad.get()
          .map(
            (pad) =>
              pad && {
                index: pad.index,
                connected: pad.connected,
                axes: [...pad.axes],
                buttons: pad.buttons.map((button) => ({
                  pressed: button.pressed,
                  value: button.value,
                })),
              }
          )
      ),
    storageExport: () =>
      execute("storageExport", async () => {
        const settings = options();
        const snapshot =
          await client("storage.read").localStorage.exportData(settings);
        settings.signal?.throwIfAborted();
        await client("files.save").files.save(
          "capability-save.json",
          JSON.stringify(snapshot),
          settings
        );
        return { entries: snapshot.entries.length };
      }),
    storageImport: () =>
      execute("storageImport", async () => {
        const signal = scope.signal;
        const snapshot: unknown = parseJsonInput(
          await file("backup-file").text()
        );
        signal.throwIfAborted();
        await client("storage.write").localStorage.importData(
          snapshot as StorageSnapshot,
          {
            signal,
            replace: (input("backup-replace") as HTMLInputElement).checked,
          }
        );
        return { imported: true };
      }),
    camera: () => execute("camera", () => startCapture("camera")),
    microphone: () => execute("microphone", () => startCapture("microphone")),
    screenCapture: () => execute("screenCapture", () => startCapture("screen")),
    captureFrame: () =>
      execute("captureFrame", async () => {
        if (!capture || capture.kind === "microphone") {
          throw failure("NOT_PLAYING");
        }
        const current = capture;
        const value = await client().media.nextFrame(current.handle, options());
        if (capture !== current) {
          throw failure("CANCELLED");
        }
        if (imageURL) {
          URL.revokeObjectURL(imageURL);
        }
        imageURL = URL.createObjectURL(
          new Blob([value.bytes], { type: value.mime })
        );
        const image = document.getElementById(
          "capture-frame"
        ) as HTMLImageElement;
        image.src = imageURL;
        image.hidden = false;
        return {
          width: value.width,
          height: value.height,
          bytes: value.bytes.byteLength,
          mime: value.mime,
        };
      }),
    recordingRead: () =>
      execute("recordingRead", async () => {
        if (capture?.kind !== "microphone") {
          throw failure("NOT_PLAYING");
        }
        if (recordingReadRequest || recordingFinishRequest) {
          throw failure("BUSY");
        }
        const current = capture;
        const request = Symbol();
        recordingReadRequest = request;
        try {
          const value = await client().media.readRecording(
            current.handle,
            options()
          );
          if (capture !== current) {
            throw failure("CANCELLED");
          }
          readChunks.push(value.bytes);
          return {
            seq: value.seq,
            bytes: value.bytes.byteLength,
            mime: value.mime,
          };
        } finally {
          if (recordingReadRequest === request) {
            recordingReadRequest = undefined;
          }
        }
      }),
    recordingFinish: () =>
      execute("recordingFinish", async () => {
        if (capture?.kind !== "microphone") {
          throw failure("NOT_PLAYING");
        }
        if (recordingReadRequest || recordingFinishRequest) {
          throw failure("BUSY");
        }
        const current = capture;
        const request = Symbol();
        recordingFinishRequest = request;
        try {
          const value = await client().media.finishRecording(
            current.handle,
            options()
          );
          if (capture !== current) {
            throw failure("CANCELLED");
          }
          capture = undefined;
          recording = new Blob(
            [...readChunks, ...value.chunks.map((chunk) => chunk.bytes)],
            { type: value.mime }
          );
          readChunks = [];
          return { bytes: recording.size, mime: value.mime };
        } finally {
          if (recordingFinishRequest === request) {
            recordingFinishRequest = undefined;
          }
        }
      }),
    captureStop: () =>
      execute("captureStop", async () => {
        await stopCapture();
        readChunks = [];
        return { stopped: true };
      }),
    recordingSave: () =>
      execute("recordingSave", async () => {
        if (!recording) {
          throw failure("NOT_PLAYING");
        }
        const extension = recording.type.includes("mp4")
          ? "m4a"
          : recording.type.includes("ogg")
            ? "ogg"
            : "webm";
        await client("files.save").files.save(
          `recording.${extension}`,
          recording,
          options()
        );
        return { saved: true };
      }),
    locate: () =>
      execute("locate", () => client("location.read").location.get(options())),
    usbOpen: () =>
      execute("usbOpen", async () => {
        const name = text("usb-name");
        if (!Object.hasOwn(manifest.devices?.usb || {}, name)) {
          throw failure("NOT_CONFIGURED");
        }
        if (usb) {
          throw failure("BUSY");
        }
        const value = await acquire(
          (settings) => client("device.usb").usb.request(name, settings),
          (device) => getSDK().usb.close(device.handle),
          (device) => {
            usb = device.handle;
          }
        );
        return {
          vendorId: value.vendorId,
          productId: value.productId,
          configurations: value.configurations.length,
        };
      }),
    usbClose: () =>
      execute("usbClose", async () => {
        const handle = usb;
        if (handle) {
          await client().usb.close(handle, options());
          if (usb === handle) {
            usb = undefined;
          }
        }
        return { closed: true };
      }),
    bluetoothOpen: () =>
      execute("bluetoothOpen", async () => {
        const name = text("bluetooth-name");
        if (!Object.hasOwn(manifest.devices?.bluetooth || {}, name)) {
          throw failure("NOT_CONFIGURED");
        }
        if (bluetooth) {
          throw failure("BUSY");
        }
        const value = await acquire(
          (settings) =>
            client("device.bluetooth").bluetooth.request(name, settings),
          (device) => getSDK().bluetooth.close(device.handle),
          (device) => {
            bluetooth = device.handle;
          }
        );
        return { connected: value.connected };
      }),
    bluetoothClose: () =>
      execute("bluetoothClose", async () => {
        const handle = bluetooth;
        if (handle) {
          await client().bluetooth.close(handle, options());
          if (bluetooth === handle) {
            bluetooth = undefined;
          }
        }
        return { closed: true };
      }),
    notifyFrontend: () =>
      execute("notifyFrontend", async () => {
        const permit = await client("notifications").notifications.request(
          "reminder",
          {
            mode: "frontend",
            reason:
              text("notification-reason") || t("notificationReasonDefault"),
            at: Date.now() + 60_000,
          }
        );
        return {
          mode: permit.mode,
          expiresAt: new Date(permit.expiresAt).toISOString(),
          ...(permit.mode === "frontend"
            ? { scheduledAt: new Date(permit.scheduledAt).toISOString() }
            : {}),
        };
      }),
    notifyBackend: () =>
      execute("notifyBackend", async () => {
        if (manifest.endpoints?.saveNotificationPermit?.method !== "POST") {
          throw failure("NOT_CONFIGURED");
        }
        client("network.request");
        const sdk = client("notifications");
        const signal = scope.signal;
        const permit = await sdk.notifications.request(
          "reminder",
          {
            mode: "backend",
            reason:
              text("notification-reason") || t("notificationReasonDefault"),
          },
          { signal }
        );
        signal.throwIfAborted();
        if (permit.mode !== "backend") {
          throw failure("INVALID_ARGUMENTS");
        }
        const response = await sdk.http.request("saveNotificationPermit", {
          method: "POST",
          json: { token: permit.token, deliveryUrl: permit.deliveryUrl },
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          throw failure("REQUEST_FAILED");
        }
        return {
          mode: permit.mode,
          expiresAt: new Date(permit.expiresAt).toISOString(),
          handedOff: true,
        };
      }),
    appCall: () =>
      execute("appCall", () => {
        const target = text("app-target");
        if (!manifest.calls?.includes(target)) {
          throw failure("NOT_CONFIGURED");
        }
        const query = parseJsonInput(input("app-query").value);
        if (!object(query)) {
          throw failure("INVALID_ARGUMENTS");
        }
        return client("app.call").app.call(
          target,
          { ...query, returnTo: manifest.id } as Parameters<
            MiniAppSDK["app"]["call"]
          >[1],
          options()
        );
      }),
    appReturn: () =>
      execute("appReturn", () => {
        const target = text("app-return-target");
        if (!target) {
          throw failure("NOT_CONFIGURED");
        }
        return client("app.call").app.return(
          target,
          parseJsonInput(input("app-query").value) as Parameters<
            MiniAppSDK["app"]["return"]
          >[1],
          options()
        );
      }),
    httpStream: () =>
      execute("httpStream", () => consume("stream-endpoint", false)),
    httpEvents: () =>
      execute("httpEvents", () => consume("events-endpoint", true)),
    eventRecover: () =>
      execute("eventRecover", () => consume("events-endpoint", true, true)),
    uploadFile: () =>
      execute("uploadFile", async () => {
        const name = endpoint("upload-endpoint");
        const source = file("upload-file");
        const body =
          input("upload-mode").value === "multipart" ? new FormData() : source;
        if (body instanceof FormData) {
          body.append("file", source, source.name);
        }
        const result = await client("network.request").http.request(name, {
          method: "POST",
          body,
          ...options(),
        });
        return { status: result.status, body: result.body };
      }),
    uploadChunks: () =>
      execute("uploadChunks", async () => {
        const sdk = client("network.request");
        const name = endpoint("upload-endpoint");
        const source = file("upload-file");
        const signal = scope.signal;
        const id = uploadId;
        try {
          return await sdk.network.uploadChunks(source, {
            signal,
            resumeOffset: Number(text("upload-offset")),
            onProgress: (value) => {
              if (signal.aborted) {
                return;
              }
              if (uploadId === id) {
                input("upload-offset").value = String(value.confirmedOffset);
              }
              write("transfer-output", value);
            },
            send: async (part) => {
              const result = await sdk.http.request(name, {
                method: "POST",
                signal: part.signal,
                body: part.chunk,
                query: {
                  upload_id: id,
                  offset: String(part.offset),
                  end: String(part.end),
                  total: String(part.total ?? source.size),
                },
              });
              if (
                !object(result.body) ||
                typeof result.body.confirmedOffset !== "number"
              ) {
                throw failure("INVALID_RESPONSE");
              }
              return { confirmedOffset: result.body.confirmedOffset };
            },
          });
        } catch (error) {
          if (
            uploadId === id &&
            object(error) &&
            Number.isSafeInteger(error.confirmedOffset)
          ) {
            input("upload-offset").value = String(error.confirmedOffset);
          }
          throw error;
        }
      }),
    socketRecover: () =>
      execute("socketRecover", async () => {
        const name = text("socket-endpoint");
        if (!Object.hasOwn(manifest.websockets || {}, name)) {
          throw failure("NOT_CONFIGURED");
        }
        if (recovery) {
          throw failure("BUSY");
        }
        const signal = scope.signal;
        const value = client("network.websocket").network.reconnectSocket(
          name,
          {
            signal,
            textMode: input("socket-text-mode").value as "auto" | "text",
            query: parseJsonInput(input("socket-query").value) as Record<
              string,
              string
            >,
            onOpen: (_socket, { reconnected }) => {
              if (!signal.aborted) {
                write("transfer-output", { state: "open", reconnected });
              }
            },
            onMessage: (eventData) => {
              if (!signal.aborted) {
                write("transfer-output", eventData);
              }
            },
          }
        );
        recovery = value;
        void value.done.then(
          () => {
            if (recovery === value) {
              recovery = undefined;
            }
          },
          (error) => {
            if (recovery === value) {
              recovery = undefined;
            }
            if (!signal.aborted) {
              write("transfer-output", { code: safeCode(error) });
            }
          }
        );
        try {
          await value.ready;
          return { state: value.state };
        } catch (error) {
          if (recovery === value) {
            recovery = undefined;
          }
          throw error;
        }
      }),
    socketRecoverClose: () =>
      execute("socketRecoverClose", async () => {
        const current = recovery;
        recovery = undefined;
        await current?.close();
        return { closed: true };
      }),
    socketText: () =>
      execute("socketText", () => {
        const current = getSocket();
        if (!current) {
          throw failure("SOCKET_CLOSED");
        }
        return current.sendText(input("socket-data").value, options());
      }),
    socketBinary: () =>
      execute("socketBinary", () => {
        const current = getSocket();
        if (!current) {
          throw failure("SOCKET_CLOSED");
        }
        return current.send(
          new TextEncoder().encode(input("socket-data").value),
          options()
        );
      }),
    extendedCancel: () =>
      run(
        "extendedCancel",
        async () => {
          await cancel();
        },
        () => write("transfer-output", { cancelled: true })
      ),
  };

  async function cancel() {
    scope.abort(failure("CANCELLED"));
    scope = new AbortController();
    captureRequest = undefined;
    worker?.terminate();
    worker = undefined;
    const socket = recovery;
    recovery = undefined;
    const usbHandle = usb;
    usb = undefined;
    const bluetoothHandle = bluetooth;
    bluetooth = undefined;
    const program = programHandle;
    programHandle = undefined;
    if (program && getVideo() === program) {
      setVideo(null);
    }
    let sdk: MiniAppSDK | undefined;
    try {
      sdk = getSDK();
    } catch {}
    await Promise.allSettled([
      stopWorklet(),
      stopCapture(),
      socket?.close(),
      ...[...readers].map((reader) => reader.cancel()),
      usbHandle ? sdk?.usb.close(usbHandle) : undefined,
      bluetoothHandle ? sdk?.bluetooth.close(bluetoothHandle) : undefined,
      program ? sdk?.video.stop(program) : undefined,
      sdk?.permissions.has("screen.keepAwake")
        ? sdk.screen.setKeepAwake(false)
        : undefined,
    ]);
  }
  function clearPrivate() {
    for (const id of new Set(Object.values(outputs))) {
      write(id, t("notTested"));
    }
    const image = document.getElementById("capture-frame") as HTMLImageElement;
    image.hidden = true;
    image.removeAttribute("src");
    if (imageURL) {
      URL.revokeObjectURL(imageURL);
      imageURL = undefined;
    }
    recording = undefined;
    readChunks = [];
    input("backup-file").value = "";
    input("upload-file").value = "";
    input("upload-offset").value = "0";
  }
  return {
    actions,
    outputs,
    cancel,
    clearPrivate,
    async initialize() {
      const sdk = client();
      if (manifest.links?.[0]) {
        input("link-target").value = manifest.links[0];
      }
      if (manifest.calls?.[0]) {
        input("app-target").value = manifest.calls[0];
      }
      if (!sdk.permissions.has("launch.read")) {
        return;
      }
      const value = await sdk.launch.getParameters();
      if (!disposed && value.query.returnTo?.[0]) {
        input("app-return-target").value = value.query.returnTo[0];
      }
    },
    dispose() {
      if (!disposed) {
        void cancel();
        clearPrivate();
        input("upload-file").removeEventListener("change", uploadChanged);
        disposed = true;
      }
    },
  };
}
