import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerStatusMonitor, probeServer, type ServerStatus } from "../lib/server-status.ts";

const ready = { ok: true, status: "ready", workflowId: "workflow/e0" };
function responses(...items: (Response | Error)[]): typeof fetch {
  return async () => {
    const next = items.shift();
    assert.ok(next, "Unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  };
}

test("healthy server does not depend on the large info manifest being available", async () => {
  const paths: string[] = [];
  assert.equal(
    await probeServer(new AbortController().signal, async (input) => {
      paths.push(String(input));
      return input === "/eve/v1/health"
        ? Response.json(ready)
        : new Response(null, { status: 503 });
    }),
    "ready",
  );
  assert.deepEqual(paths, ["/eve/v1/health"]);
});

test("an arbitrary HTTP 200 is not health; missing health falls back to info", async () => {
  assert.equal(
    await probeServer(
      new AbortController().signal,
      responses(Response.json({}), Response.json({ ok: true })),
    ),
    "unavailable",
  );
  const paths: string[] = [];
  assert.equal(
    await probeServer(new AbortController().signal, async (input) => {
      paths.push(String(input));
      return new Response(null, { status: input === "/eve/v1/health" ? 404 : 403 });
    }),
    "forbidden",
  );
  assert.deepEqual(paths, ["/eve/v1/health", "/eve/v1/info"]);
});

test("auth and permission failures remain distinct from an unreachable server", async () => {
  for (const [code, expected] of [
    [401, "auth-required"],
    [403, "forbidden"],
  ] as const) {
    assert.equal(
      await probeServer(
        new AbortController().signal,
        responses(new Response(null, { status: code })),
      ),
      expected,
    );
  }
});

test("transient network and 5xx failures retry once, then recover or report unavailable", async () => {
  for (const failure of [new TypeError("Network error"), new Response(null, { status: 503 })]) {
    assert.equal(
      await probeServer(new AbortController().signal, responses(failure, Response.json(ready))),
      "ready",
    );
  }
  assert.equal(
    await probeServer(
      new AbortController().signal,
      responses(new TypeError("Offline"), new TypeError("Offline")),
    ),
    "unavailable",
  );
});

test("polling recovers from unreachable without reload or focus", async () => {
  const statuses: ServerStatus[] = [];
  let calls = 0;
  let recovered!: () => void;
  const recovery = new Promise<void>((resolve) => {
    recovered = resolve;
  });
  const monitor = createServerStatusMonitor({
    isHidden: () => false,
    intervalMs: 5,
    probe: async () => (++calls === 1 ? "unavailable" : "ready"),
    onStatus: (status) => {
      statuses.push(status);
      if (status === "ready") recovered();
    },
  });
  try {
    await monitor.check();
    await recovery;
    assert.deepEqual(statuses, ["unavailable", "ready"]);
  } finally {
    monitor.dispose();
  }
});

test("a cancelled background check cannot overwrite a fresh visible check", async () => {
  let hidden = false;
  const statuses: ServerStatus[] = [];
  const pending: { signal: AbortSignal; resolve: (value: "ready" | "unavailable") => void }[] = [];
  const monitor = createServerStatusMonitor({
    isHidden: () => hidden,
    onStatus: (status) => statuses.push(status),
    probe: (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
  });
  try {
    const first = monitor.check();
    await monitor.check();
    assert.equal(pending.length, 1, "concurrent focus events reuse the active check");
    hidden = true;
    monitor.visibilityChanged();
    assert.equal(pending[0].signal.aborted, true);
    hidden = false;
    monitor.visibilityChanged();
    pending[1].resolve("ready");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[0].resolve("unavailable");
    await first;
    assert.deepEqual(statuses, ["ready"]);
  } finally {
    monitor.dispose();
  }
});

test("a stalled request is aborted at the deadline and cancellation does not retry", async () => {
  let calls = 0;
  const stalled: typeof fetch = async (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init!.signal!.throwIfAborted();
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
  // AbortSignal.timeout does not keep the Node test process alive.
  const keepAlive = setInterval(() => {}, 100);
  try {
    assert.equal(await probeServer(new AbortController().signal, stalled, 20), "unavailable");
    assert.equal(calls, 1);
    const controller = new AbortController();
    const result = probeServer(controller.signal, stalled);
    controller.abort();
    assert.equal(await result, "unavailable");
    assert.equal(calls, 2);
  } finally {
    clearInterval(keepAlive);
  }
});

test("probe works without AbortSignal static combinators", async () => {
  const any = AbortSignal.any,
    timeout = AbortSignal.timeout;
  try {
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    assert.equal(
      await probeServer(new AbortController().signal, responses(Response.json(ready))),
      "ready",
    );
  } finally {
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: any });
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: timeout });
  }
});
