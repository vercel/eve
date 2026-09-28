import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import {
  CLIENT_MJS_SOURCE,
  SERVER_MJS_SOURCE,
  TYPING_MJS_SOURCE,
} from "../../extension/lib/computer-use-driver-source.ts";

type Action = { action: string; [key: string]: unknown };
type DriverResult = { structuredJson?: string; isError?: boolean; text?: string };

class Response extends EventEmitter {
  destroyed = false;
  finished = false;
  status = 0;
  body = "";
  writeHead(status: number) {
    this.status = status;
  }
  end(body: string) {
    this.body = body;
    this.finished = true;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

async function harness() {
  let now = 1_000;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, ms: number) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + ms, callback });
    return id;
  };
  const delay = (ms: number, _value: unknown, { signal }: { signal?: AbortSignal }) =>
    new Promise<void>((resolveDelay, reject) => {
      signal?.throwIfAborted();
      const abort = () => {
        timers.delete(id);
        reject(signal?.reason);
      };
      const id = schedule(() => {
        signal?.removeEventListener("abort", abort);
        resolveDelay();
      }, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  const events: string[] = [];
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const responses: Response[] = [];
  let callback: (
    request: Readable & { method: string; url: string; headers: object },
    response: Response,
  ) => void;
  let native: (name: string) => Promise<DriverResult> = async () => ({});
  const signals = new Map<string, () => void>();
  const naturalTypingPlan = new Function(
    `${TYPING_MJS_SOURCE.replace("export function", "function")}\nreturn naturalTypingPlan;`,
  )();
  const source = SERVER_MJS_SOURCE.replace(/^import .*;\n/gmu, "");
  const api = (await new Function(
    "dependencies",
    `
    return (async () => {
      const { delay, execFile, execFileSync, randomUUID, chmod, rename, rm,
        promisify, http, env, dirname, resolve, CuaDriver, naturalTypingPlan,
        setTimeout, clearTimeout, process, Date } = dependencies;
      ${source}
      return { idle: () => queue };
    })();
  `,
  )({
    delay,
    promisify,
    dirname,
    resolve,
    naturalTypingPlan,
    execFile: () => {
      throw new Error("unexpected subprocess");
    },
    execFileSync: () => "dimensions: 1920x1080 pixels",
    randomUUID: () => "take",
    chmod: async () => {},
    rename: async (from: string, to: string) => {
      events.push(`rename:${from}:${to}`);
    },
    rm: async () => {},
    env: { COMPUTER_USE_ROOT: "/workspace/computer-use", COMPUTER_USE_SOCKET_PATH: "/socket" },
    CuaDriver: {
      create: async () => ({
        callTool: async (name: string, input: string) => {
          calls.push({ name, input: JSON.parse(input) });
          events.push(name);
          return native(name);
        },
        shutdown: async () => {
          events.push("shutdown");
        },
      }),
    },
    http: {
      createServer: (handler: typeof callback) => {
        callback = handler;
        return {
          listen: (_path: string, ready: () => void) => ready(),
          close: () => {},
          closeAllConnections: () => {
            for (const response of responses) if (!response.finished) response.destroy();
          },
        };
      },
    },
    process: {
      once: (signal: string, handler: () => void) => signals.set(signal, handler),
      exit: (code: number) => {
        events.push(`exit:${code}`);
      },
    },
    setTimeout: schedule,
    clearTimeout: (id: number) => timers.delete(id),
    Date: { now: () => now },
  })) as { idle(): Promise<void> };

  const flush = async () => {
    await setImmediate();
  };
  return {
    calls,
    events,
    timers,
    setNative(value: typeof native) {
      native = value;
    },
    async request(action: Action, deadline?: number) {
      const request = Object.assign(
        Readable.from([
          JSON.stringify({
            action,
            screenshotPath: "/workspace/computer-use/latest.png",
          }),
        ]),
        {
          method: "POST",
          url: "/call",
          headers:
            deadline === undefined ? {} : { "x-computer-use-deadline": String(now + deadline) },
        },
      );
      const response = new Response();
      response.once("close", () => request.destroy());
      responses.push(response);
      callback(request, response);
      await flush();
      return response;
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
    async signal(signal: string) {
      signals.get(signal)?.();
      await flush();
    },
    idle: api.idle,
    flush,
  };
}

test("forgotten recordings finalize at five minutes and release recording state", async () => {
  const h = await harness();
  await h.request({ action: "record_start", path: "/workspace/computer-use/take.mp4" });
  await h.idle();
  await h.advance(299_999);
  assert.equal(h.calls.filter(({ name }) => name === "stop_recording").length, 0);
  await h.advance(1);
  assert.ok(
    h.events.includes(
      "rename:/workspace/computer-use/recording-take/recording.mp4:/workspace/computer-use/take.mp4",
    ),
  );
  assert.equal(h.calls.filter(({ name }) => name === "stop_recording").length, 1);
  assert.equal(
    (await h.request({ action: "record_start", path: "/workspace/computer-use/next.mp4" })).status,
    200,
  );
});

test("explicit stop clears the watchdog", async () => {
  const h = await harness();
  await h.request({ action: "record_start", path: "/workspace/computer-use/take.mp4" });
  await h.request({ action: "record_stop" });
  await h.idle();
  assert.equal(h.timers.size, 0);
  await h.advance(300_000);
  assert.equal(h.calls.filter(({ name }) => name === "stop_recording").length, 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} finalizes a recording before driver shutdown`, async () => {
    const h = await harness();
    await h.request({ action: "record_start", path: "/workspace/computer-use/take.mp4" });
    await h.signal(signal);
    assert.ok(h.events.indexOf("stop_recording") < h.events.indexOf("shutdown"));
    assert.match(h.events[h.events.indexOf("shutdown") - 1] ?? "", /^rename:/u);
    assert.equal(h.events.at(-1), "exit:0");
    assert.equal(h.timers.size, 0);
  });
}

test("shutdown waits for an in-flight recording start before finalizing it", async () => {
  const h = await harness();
  let finishStart!: (result: DriverResult) => void;
  const started = new Promise<DriverResult>((resolveStart) => {
    finishStart = resolveStart;
  });
  h.setNative(async (name) => (name === "start_recording" ? started : {}));
  await h.request({ action: "record_start", path: "/workspace/computer-use/take.mp4" });
  await h.signal("SIGTERM");
  assert.equal(h.events.includes("shutdown"), false);
  finishStart({});
  await h.flush();
  assert.ok(h.events.includes("stop_recording"));
  assert.equal(h.events.at(-1), "exit:0");
});

test("watchdog and explicit stop share one finalization", async () => {
  const h = await harness();
  let finishStop!: (result: DriverResult) => void;
  const stopped = new Promise<DriverResult>((resolveStop) => {
    finishStop = resolveStop;
  });
  h.setNative(async (name) => (name === "stop_recording" ? stopped : {}));
  await h.request({ action: "record_start", path: "/workspace/computer-use/take.mp4" });
  await h.advance(300_000);
  const response = await h.request({ action: "record_stop" });
  finishStop({});
  await h.idle();
  assert.equal(response.status, 200);
  assert.equal(h.calls.filter(({ name }) => name === "stop_recording").length, 1);
  assert.equal(h.events.filter((event) => event.startsWith("rename:")).length, 1);
});

test("typing budget rejects total paced work before any sequence side effects", async () => {
  const h = await harness();
  for (const action of [
    { action: "type", text: "a".repeat(10_000), typingDelayMs: 200 },
    { action: "type", text: "a".repeat(1_001), typingDelayMs: 1 },
    { action: "type", text: "a".repeat(1_000), typingStyle: "natural" },
    {
      action: "sequence",
      actions: [
        { action: "record_start", path: "/workspace/computer-use/take.mp4" },
        { action: "type", text: "a".repeat(100), typingDelayMs: 200 },
        { action: "type", text: "b".repeat(100), typingDelayMs: 200 },
        { action: "record_stop" },
      ],
    },
  ]) {
    const response = await h.request(action);
    assert.equal(response.status, 500);
    assert.match(response.body, /typing budget exceeded/u);
  }
  assert.equal(h.calls.length, 0);
});

test("unpaced text stays batched and paced results retain only the last result", async () => {
  const h = await harness();
  await h.request({ action: "type", text: "a".repeat(10_000) });
  assert.equal(h.calls.filter(({ name }) => name === "type_text").length, 1);
  const response = await h.request({ action: "type", text: "a👩‍💻b", typingDelayMs: 1 });
  await h.advance(3);
  await h.idle();
  assert.deepEqual(JSON.parse(response.body).action, { graphemesTyped: 3, result: {} });
  assert.deepEqual(
    h.calls
      .filter(({ name }) => name === "type_text")
      .slice(1)
      .map(({ input }) => input.text),
    ["a", "👩‍💻", "b"],
  );
});

test("disconnect interrupts pacing and releases the queue without further typing", async () => {
  const h = await harness();
  const response = await h.request({ action: "type", text: "abc", typingDelayMs: 200 });
  response.destroy();
  const next = await h.request({ action: "screenshot" });
  await h.idle();
  assert.equal(next.status, 200);
  assert.equal(h.calls.filter(({ name }) => name === "type_text").length, 1);
  assert.equal(h.timers.size, 0);
});

test("a queued disconnected or expired request never executes", async () => {
  const h = await harness();
  await h.request({ action: "wait", durationMs: 100 });
  const expired = await h.request({ action: "type", text: "expired" }, 50);
  const disconnected = await h.request({ action: "type", text: "disconnected" });
  disconnected.destroy();
  await h.advance(100);
  await h.idle();
  assert.equal(expired.destroyed, true);
  assert.equal(
    h.calls.some(({ name }) => name === "type_text"),
    false,
  );
  assert.equal((await h.request({ action: "screenshot" })).status, 200);
});

test("an already-expired request cannot mutate the desktop", async () => {
  const h = await harness();
  const response = await h.request({ action: "type", text: "expired" }, -1);
  await h.idle();
  assert.equal(response.destroyed, true);
  assert.equal(h.calls.length, 0);
});

test("server caps request lifetime at two minutes even with a later client deadline", async () => {
  const h = await harness();
  const response = await h.request(
    {
      action: "sequence",
      actions: Array.from({ length: 30 }, () => ({
        action: "wait",
        durationMs: 10_000,
      })),
    },
    300_000,
  );
  await h.advance(120_000);
  await h.idle();
  assert.equal(response.destroyed, true);
  assert.equal((await h.request({ action: "screenshot" })).status, 200);
});

test("deadline cancels an active sequence and finalizes its recording", async () => {
  const h = await harness();
  const response = await h.request(
    {
      action: "sequence",
      actions: [
        { action: "record_start", path: "/workspace/computer-use/take.mp4" },
        { action: "wait", durationMs: 1_000 },
        { action: "type", text: "too late" },
        { action: "record_stop" },
      ],
    },
    100,
  );
  await h.advance(100);
  await h.idle();
  assert.equal(response.destroyed, true);
  assert.equal(h.calls.filter(({ name }) => name === "stop_recording").length, 1);
  assert.equal(
    h.calls.some(({ name }) => name === "type_text"),
    false,
  );
  assert.equal((await h.request({ action: "screenshot" })).status, 200);
});

test("a stalled native call shuts down instead of letting later work overlap", async () => {
  const h = await harness();
  h.setNative(async () => new Promise(() => {}));
  await h.request({ action: "type", text: "stalled" });
  const next = await h.request({ action: "type", text: "must not execute" });
  await h.advance(10_000);
  await h.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(next.destroyed, true);
  assert.ok(h.events.includes("shutdown"));
  assert.equal(h.events.at(-1), "exit:0");
});

test("the embedded client forwards its absolute deadline and destroys timed-out requests", async () => {
  let timeout: (() => void) | undefined;
  let headers: Record<string, string> = {};
  const request = Object.assign(new EventEmitter(), {
    end: () => {},
    destroy: (error: Error) => {
      request.emit("error", error);
      request.emit("close");
    },
  });
  const result = new Function(
    "http",
    "env",
    "setTimeout",
    "clearTimeout",
    `
    return (async () => { ${CLIENT_MJS_SOURCE.replace(/^import .*;\n/gmu, "")} })();
  `,
  )(
    {
      request: (options: { headers: Record<string, string> }) => {
        headers = options.headers;
        return request;
      },
    },
    { COMPUTER_USE_SOCKET_PATH: "/socket", COMPUTER_USE_REQUEST: "{}" },
    (callback: () => void) => {
      timeout = callback;
    },
    () => {},
  ) as Promise<void>;
  const rejected = assert.rejects(result, /request deadline exceeded/u);
  assert.ok(Number(headers["x-computer-use-deadline"]) > Date.now());
  timeout?.();
  await rejected;
});
