import type {
  CaptureSnapshot,
  MiniAppSDK,
  NotificationPermit,
} from "@discourse-mini-app/sdk";
import type { MiniAppManifest } from "@discourse-mini-app/sdk/pack";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createExtendedSamples } from "../src/extended.ts";
import { createRunner } from "../src/state.ts";

class Field extends EventTarget {
  value = "";
  hidden = false;
  src = "";

  removeAttribute(name: string) {
    if (name === "src") {
      this.src = "";
    }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
let documentDescriptor: PropertyDescriptor | undefined;
let fields: Map<string, Field>;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  fields = new Map();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById(id: string) {
        if (!fields.has(id)) {
          fields.set(id, new Field());
        }
        return fields.get(id)!;
      },
    },
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  if (documentDescriptor) {
    Object.defineProperty(globalThis, "document", documentDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "document");
  }
});

async function sample(
  methods: object,
  granted: string[],
  endpoints: MiniAppManifest["endpoints"] = {}
) {
  // Fixtures provide only the SDK namespaces exercised by their public actions.
  const sdk = {
    ready: Promise.resolve(),
    permissions: { has: (name: string) => granted.includes(name) },
    ...methods,
  } as unknown as MiniAppSDK;
  const runner = createRunner(sdk);
  await runner.connect();
  const shown: unknown[] = [];
  const samples = createExtendedSamples({
    getSDK: () => sdk,
    manifest: { id: "demo", calls: [], links: [], endpoints },
    run: async (operation, action, after, options) => {
      const result = await runner.run(operation, action, options);
      if (result.accepted) {
        after?.(result.value);
      }
    },
    show: (_id, value) => shown.push(value),
    t: (key) => key,
    getVideo: () => null,
    setVideo: () => {},
    getSocket: () => null,
  });
  cleanups.push(async () => {
    await samples.cancel();
    samples.dispose();
  });
  return { samples, shown };
}

describe("extended capability samples", () => {
  test("terminates a Worker acquired after cancellation without sending work", async () => {
    const started = deferred<Worker>();
    let terminated = 0;
    let posted = 0;
    const value = {
      terminate() {
        terminated++;
      },
      postMessage() {
        posted++;
      },
    } as unknown as Worker;
    const { samples, shown } = await sample(
      { workers: { create: () => started.promise } },
      ["workers.create"]
    );
    const running = samples.actions.workerRun!();
    await samples.cancel();
    started.resolve(value);
    await running;
    expect(terminated).toBe(1);
    expect(posted).toBe(0);
    expect(shown).toEqual([]);
  });

  test("stops late capture after disposal rather than retaining the device", async () => {
    const started = deferred<CaptureSnapshot>();
    const stopped: string[] = [];
    const { samples } = await sample(
      {
        media: {
          capture: () => started.promise,
          stop: async (handle: string) => {
            stopped.push(handle);
            return null;
          },
        },
      },
      ["camera"]
    );
    const running = samples.actions.camera!();
    samples.dispose();
    started.resolve({
      handle: "late-camera",
      kind: "camera",
      mime: null,
      tracks: [],
    });
    await running;
    expect(stopped).toEqual(["late-camera"]);
  });

  test("requests a frontend notification synchronously inside the action", async () => {
    const permit = deferred<NotificationPermit>();
    const calls: unknown[] = [];
    const { samples, shown } = await sample(
      {
        notifications: {
          request: (...args: unknown[]) => {
            calls.push(args);
            return permit.promise;
          },
        },
      },
      ["notifications"]
    );
    const running = samples.actions.notifyFrontend!();
    expect(calls).toHaveLength(1);
    permit.resolve({
      mode: "frontend",
      expiresAt: Date.now() + 86_400_000,
      scheduledAt: Date.now() + 60_000,
    });
    await running;
    expect(shown).toHaveLength(1);
  });

  test("hands backend permission to the configured endpoint without displaying its token", async () => {
    const requests: unknown[] = [];
    const { samples, shown } = await sample(
      {
        notifications: {
          request: async () => ({
            mode: "backend",
            token: "private-permit",
            expiresAt: Date.now() + 86_400_000,
            deliveryUrl: "https://forum.example/delivery",
          }),
        },
        http: {
          request: async (...args: unknown[]) => {
            requests.push(args);
            return { status: 202, body: null };
          },
        },
      },
      ["notifications", "network.request"],
      {
        saveNotificationPermit: {
          url: "https://api.example/permit",
          method: "POST",
        },
      }
    );
    await samples.actions.notifyBackend!();
    expect(JSON.stringify(requests)).toContain("private-permit");
    expect(JSON.stringify(shown)).not.toContain("private-permit");
    expect(shown).toEqual([
      expect.objectContaining({ mode: "backend", handedOff: true }),
    ]);
  });
});
