import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

type ProviderEvent =
  | "handler-ready"
  | "stream-start"
  | "first-delta-gate"
  | "first-delta"
  | "interrupted"
  | "completed"
  | "listener-settled"
  | "stream-settled"
  | "underlying-cancel"
  | "watchdog";

interface Rendezvous {
  close(): Promise<void>;
  readonly events: readonly ProviderEvent[];
  readonly reports: readonly { readonly attempt: number; readonly event: ProviderEvent }[];
  readonly nonce: string;
  allowFirstDelta(): void;
  release(): void;
  readonly url: string;
  waitFor(event: ProviderEvent): Promise<void>;
  waitForAttempt(event: ProviderEvent, attempt: number): Promise<void>;
  waitForReport(
    matches: (report: { readonly attempt: number; readonly event: ProviderEvent }) => boolean,
  ): Promise<{ readonly attempt: number; readonly event: ProviderEvent }>;
}

describe("public model-stream cancellation", () => {
  it.each(["abort-then-cancel", "cancel-then-abort"] as const)(
    "settles a direct underlying ReadableStream cancel once when %s races",
    async (order) => {
      const probe = createDirectCancellationProbe();
      const reader = probe.stream.getReader();
      const unhandled: unknown[] = [];
      const captureUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", captureUnhandled);

      try {
        if (order === "abort-then-cancel") {
          probe.abort();
          await reader.cancel();
        } else {
          await reader.cancel();
          probe.abort();
        }
        await Promise.resolve();
      } finally {
        process.off("unhandledRejection", captureUnhandled);
      }

      expect(probe.events.filter((event) => event === "underlying-cancel")).toHaveLength(1);
      expect(probe.events.filter((event) => event === "settled")).toHaveLength(1);
      expect(probe.abortCalls).toBe(order === "abort-then-cancel" ? 1 : 0);
      expect(probe.listenerRemoved).toBe(true);
      expect(unhandled).toEqual([]);
    },
  );

  it("keeps a completed turn completed when exact-id cancellation arrives after provider completion", async () => {
    const app = await scenarioApp({
      dependencies: { zod: "^4.3.6" },
      files: {
        "agent/agent.ts": finiteAgentSource,
        "agent/instructions.md": "Reply with the streamed response.\n",
      },
      installDependencies: true,
      name: "public-model-stream-late-cancellation",
    });
    const server = await startEveDev(app.appRoot);

    try {
      const client = new Client({ host: server.url });
      const { response, session } = await client.sessions.create({
        message: "Complete before cancelling.",
      });
      const events: MessageStreamEvent[] = [];
      let turnId: string | undefined;

      for await (const event of response) {
        events.push(event);
        if (event.type === "turn.started") turnId = event.data.turnId;
      }

      expect(turnId).toBeDefined();
      expect(await session.cancel({ turnId })).toMatchObject({ status: "accepted" });
      expect(events.map((event) => event.type)).toContain("message.completed");
      expect(events.map((event) => event.type)).toContain("step.completed");
      expect(events.map((event) => event.type)).toContain("turn.completed");
      expect(events.at(-1)?.type).toBe("session.waiting");
      expect(events.map((event) => event.type)).not.toContain("turn.cancelled");
      expect(events.map((event) => event.type)).not.toContain("turn.failed");
      expect(events.map((event) => event.type)).not.toContain("session.failed");
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("aborts one first-delta-held provider through exact public turn cancellation", async () => {
    const result = await runHeldProviderScenario({ cancel: "exact" });

    expect(result.cancelResults).toHaveLength(1);
    expect(result.cancelResults[0]).toMatchObject({
      sessionId: result.sessionId,
      status: "accepted",
    });
    expect(result.rendezvous.events).toContain("first-delta");
    expect(result.rendezvous.events).toContain("interrupted");
    expect(result.rendezvous.events).not.toContain("completed");
    expect(result.rendezvous.events).not.toContain("watchdog");
    expectCancelledLifecycle(result.events);
    expect(result.rendezvous.events).toContain("listener-settled");
    expect(result.rendezvous.events).toContain("stream-settled");
    expect(result.rendezvous.events.filter((event) => event === "interrupted")).toHaveLength(1);
  }, 120_000);

  it("keeps the id-less public compatibility path cancellable after the provider delta", async () => {
    const result = await runHeldProviderScenario({ cancel: "omitted" });

    expect(result.cancelResults).toHaveLength(1);
    expect(result.cancelResults[0]).toMatchObject({
      sessionId: result.sessionId,
      status: "accepted",
    });
    expect(result.rendezvous.events).toContain("interrupted");
    expectCancelledLifecycle(result.events);
  }, 120_000);

  it("ignores a wrong id and cancels exactly once before the first provider delta", async () => {
    const wrong = await runHeldProviderScenario({ cancel: "wrong" });

    expect(wrong.rendezvous.events).toContain("first-delta");
    expect(wrong.rendezvous.events).toContain("completed");
    expect(wrong.rendezvous.events).not.toContain("interrupted");
    expectCompletedLifecycle(wrong.events);

    const preDelta = await runHeldProviderScenario({ cancel: "pre-delta" });

    expect(preDelta.rendezvous.events).toContain("handler-ready");
    expect(preDelta.rendezvous.events).not.toContain("first-delta");
    expect(preDelta.rendezvous.events).toContain("interrupted");
    expectCancelledLifecycle(preDelta.events);
  }, 120_000);

  it("settles duplicate exact-id cancellation once without a stale successful terminal", async () => {
    const result = await runHeldProviderScenario({ cancel: "duplicate" });

    expect(result.cancelResults).toHaveLength(2);
    expect(result.cancelResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: result.sessionId, status: "accepted" }),
        expect.objectContaining({ sessionId: result.sessionId, status: "accepted" }),
      ]),
    );
    expect(result.rendezvous.events.filter((event) => event === "interrupted")).toHaveLength(1);
    try {
      expectCancelledLifecycle(result.events);
    } catch (error) {
      throw new Error(
        `Recovered durable event log was not a single cancellation lifecycle: ${JSON.stringify(result.events)}`,
        { cause: error },
      );
    }
  }, 120_000);

  it("recovers the cancelled public session after an Eve process restart", async () => {
    const result = await runHeldProviderScenario({ cancel: "exact", restartAfterCancel: true });

    expectCancelledLifecycle(result.events);
  }, 120_000);

  it("crashes an active provider, redrives it after restart, then cancels its exact public turn", async () => {
    const result = await runHeldProviderScenario({ cancel: "exact", crashBeforeCancel: true });
    const recovery = result.recovery;
    if (recovery === undefined) throw new Error("Expected active-provider recovery evidence.");

    expect(result.rendezvous.reports).toEqual(
      expect.arrayContaining([
        { attempt: recovery.crashedAttempt, event: "handler-ready" },
        { attempt: recovery.crashedAttempt, event: "first-delta" },
        { attempt: recovery.replacementAttempt, event: "handler-ready" },
        { attempt: recovery.replacementAttempt, event: "first-delta" },
        { attempt: recovery.replacementAttempt, event: "interrupted" },
        { attempt: recovery.replacementAttempt, event: "listener-settled" },
        { attempt: recovery.replacementAttempt, event: "stream-settled" },
      ]),
    );
    expect(recovery.replacementAttempt).toBeGreaterThan(recovery.crashedAttempt);
    expect(
      result.rendezvous.reports.filter(
        (report) => report.attempt === recovery.crashedAttempt && report.event === "completed",
      ),
    ).toHaveLength(0);
    expect(
      result.rendezvous.reports.filter(
        (report) =>
          report.attempt === recovery.replacementAttempt && report.event === "interrupted",
      ),
    ).toHaveLength(1);
    expect(
      result.rendezvous.reports.filter(
        (report) =>
          report.attempt === recovery.replacementAttempt && report.event === "listener-settled",
      ),
    ).toHaveLength(1);
    expect(
      result.rendezvous.reports.filter(
        (report) =>
          report.attempt === recovery.replacementAttempt && report.event === "stream-settled",
      ),
    ).toHaveLength(1);
    expect(result.rendezvous.reports.filter((report) => report.event === "watchdog")).toEqual([]);
    try {
      expectCancelledLifecycle(result.events);
    } catch (error) {
      throw new Error(
        `Recovered durable event log was not a single cancellation lifecycle: ${JSON.stringify(result.events)}`,
        { cause: error },
      );
    }
  }, 120_000);
});

async function runHeldProviderScenario(input: {
  readonly cancel: "exact" | "omitted" | "wrong" | "duplicate" | "pre-delta";
  readonly crashBeforeCancel?: boolean;
  readonly restartAfterCancel?: boolean;
}): Promise<{
  readonly cancelResults: Array<{ readonly sessionId?: string; readonly status: string }>;
  readonly events: MessageStreamEvent[];
  readonly recovery?: { readonly crashedAttempt: number; readonly replacementAttempt: number };
  readonly rendezvous: Rendezvous;
  readonly sessionId: string;
}> {
  const rendezvous = await startRendezvous();
  const app = await scenarioApp({
    dependencies: { zod: "^4.3.6" },
    files: {
      "agent/agent.ts": heldAgentSource,
      "agent/instructions.md": "Reply with the streamed response.\n",
    },
    installDependencies: true,
    name: `public-model-stream-held-cancellation-${input.cancel}`,
  });
  let server = await startEveDev(app.appRoot, {
    env: { EVE_TEST_RENDEZVOUS_NONCE: rendezvous.nonce, EVE_TEST_RENDEZVOUS_URL: rendezvous.url },
    useAuthoredModel: true,
  });
  const events: MessageStreamEvent[] = [];
  let recovery:
    | { readonly crashedAttempt: number; readonly replacementAttempt: number }
    | undefined;
  let recoveredStream:
    | {
        readonly close: () => Promise<void>;
        readonly expectNoEvent: () => Promise<void>;
      }
    | undefined;

  try {
    const client = new Client({ host: server.url });
    const { response, session } = await client.sessions.create({
      message: "Start the held stream.",
    });
    const cancelResults: Array<{ readonly sessionId?: string; readonly status: string }> = [];
    let turnId: string | undefined;
    let resolveTurnId: ((value: string) => void) | undefined;
    const started = new Promise<string>((resolve) => {
      resolveTurnId = resolve;
    });
    let reachedTerminal = false;
    const consume = (async () => {
      for await (const event of response) {
        if (reachedTerminal) {
          throw new Error("Public stream emitted an event after terminal session.waiting.");
        }
        events.push(event);
        if (event.type === "turn.started") {
          if (
            turnId !== undefined ||
            typeof event.data.turnId !== "string" ||
            event.data.turnId.length === 0
          ) {
            throw new Error("Expected exactly one public turn.started id for the full stream.");
          }
          turnId = event.data.turnId;
          resolveTurnId?.(turnId);
        }
        if (event.type === "session.waiting") reachedTerminal = true;
      }
    })();

    const [exactTurnId] = await Promise.all([
      withinDeadline(started, "public stream did not expose a turn id"),
      withinDeadline(
        rendezvous.waitFor("handler-ready"),
        "provider did not install its abort handler",
      ),
    ]);
    if (input.crashBeforeCancel === true) {
      rendezvous.allowFirstDelta();
      await withinDeadline(
        rendezvous.waitFor("first-delta"),
        "provider did not become active before the crash",
      );
      const crashedAttempt = rendezvous.reports.findLast(
        (report) => report.event === "first-delta",
      )?.attempt;
      if (crashedAttempt === undefined) throw new Error("Active provider lacked an attempt index.");
      const preCrashSnapshot = await session.snapshot();
      events.splice(0, events.length, ...preCrashSnapshot.events);
      const crashedUrl = server.url;
      await server.crash();
      expect(server.isProcessTreeAbsent()).toBe(true);
      await expect(fetch(crashedUrl)).rejects.toThrow();
      // The old HTTP follower may be reconnecting to the just-killed URL; it
      // is intentionally not the recovery mechanism. Keep its rejection
      // handled while the new public attachment takes over below.
      void consume.catch(() => undefined);

      server = await startEveDev(app.appRoot, {
        env: {
          EVE_TEST_RENDEZVOUS_NONCE: rendezvous.nonce,
          EVE_TEST_RENDEZVOUS_URL: rendezvous.url,
          WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1",
        },
        useAuthoredModel: true,
      });
      const recovered = new Client({ host: server.url }).sessions.attach(session.state.sessionId, {
        streamIndex: preCrashSnapshot.session.streamIndex,
      });
      const recoveredEvents: MessageStreamEvent[] = [];
      const recoveredConsume = readThroughSessionWaiting(
        recovered.stream()[Symbol.asyncIterator](),
        recoveredEvents,
      );
      const replacement = await withinDeadline(
        rendezvous.waitForReport(
          (report) => report.event === "handler-ready" && report.attempt > crashedAttempt,
        ),
        "restarted Eve process did not redrive the active provider",
        30_000,
      );
      recovery = { crashedAttempt, replacementAttempt: replacement.attempt };
      try {
        await withinDeadline(
          rendezvous.waitForAttempt("first-delta", replacement.attempt),
          "replacement provider did not become active",
        );
      } catch (error) {
        throw new Error(
          [
            "Replacement provider failed before its first delta.",
            `reports: ${JSON.stringify(rendezvous.reports)}`,
            `stdout: ${server.stdout()}`,
            `stderr: ${server.stderr()}`,
          ].join("\n\n"),
          { cause: error },
        );
      }
      cancelResults.push(await recovered.cancel({ turnId: exactTurnId }));
      try {
        recoveredStream = await withinDeadline(
          recoveredConsume,
          "recovered public stream did not settle after cancellation",
        );
      } catch (error) {
        throw new Error(
          [
            "Exact cancellation did not terminalize the recovered public stream.",
            `cancel results: ${JSON.stringify(cancelResults)}`,
            `reports: ${JSON.stringify(rendezvous.reports)}`,
            `events: ${JSON.stringify(recoveredEvents.map((event) => event.type))}`,
            `stdout: ${server.stdout()}`,
            `stderr: ${server.stderr()}`,
          ].join("\n\n"),
          { cause: error },
        );
      }
    } else if (input.cancel === "pre-delta") {
      cancelResults.push(await session.cancel({ turnId: exactTurnId }));
    } else {
      rendezvous.allowFirstDelta();
      await withinDeadline(
        rendezvous.waitFor("first-delta"),
        "provider did not expose its first delta",
      );
      if (input.cancel === "wrong") {
        cancelResults.push(await session.cancel({ turnId: `${exactTurnId}-wrong` }));
        rendezvous.release();
      } else if (input.cancel === "omitted") {
        cancelResults.push(await session.cancel());
      } else {
        cancelResults.push(await session.cancel({ turnId: exactTurnId }));
        if (input.cancel === "duplicate")
          cancelResults.push(await session.cancel({ turnId: exactTurnId }));
      }
    }
    if (input.crashBeforeCancel !== true)
      await withinDeadline(consume, "public stream did not settle after cancellation");
    if (turnId !== exactTurnId) throw new Error("The public turn id changed during cancellation.");
    if (input.cancel !== "wrong") {
      await withinDeadline(
        rendezvous.waitFor("listener-settled"),
        "provider abort listener did not settle",
      );
      await withinDeadline(
        rendezvous.waitFor("stream-settled"),
        "provider stream reader did not settle",
      );
    }
    if (input.restartAfterCancel === true) {
      await server.crash();
      server = await startEveDev(app.appRoot, {
        env: {
          EVE_TEST_RENDEZVOUS_NONCE: rendezvous.nonce,
          EVE_TEST_RENDEZVOUS_URL: rendezvous.url,
        },
        useAuthoredModel: true,
      });
      const recovered = new Client({ host: server.url }).sessions.attach(session.state.sessionId);
      const snapshot = await recovered.snapshot();
      expect(snapshot.session.sessionId).toBe(session.state.sessionId);
      expectCancelledLifecycle(snapshot.events);
    }
    if (input.crashBeforeCancel === true) {
      // The exact replacement provider and source reader must both settle
      // before this final source-log snapshot. A bounded extra pull then
      // proves no late public record arrives before the follower closes.
      const snapshot = await new Client({ host: server.url }).sessions
        .attach(session.state.sessionId)
        .snapshot();
      expectCancelledLifecycle(snapshot.events);
      events.splice(0, events.length, ...snapshot.events);
      await recoveredStream?.expectNoEvent();
      await recoveredStream?.close();
      await server.stop();
      expect(server.isProcessTreeAbsent()).toBe(true);
    }
    if (
      cancelResults.some(
        (result) => result.status !== "accepted" || result.sessionId !== session.state.sessionId,
      )
    ) {
      throw new Error("Cancellation acknowledgement did not bind the active public session.");
    }
    return { cancelResults, events, recovery, rendezvous, sessionId: session.state.sessionId };
  } finally {
    rendezvous.release();
    await server.stop();
    await rendezvous.close();
  }
}

function expectCancelledLifecycle(events: readonly MessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  const started = types.indexOf("turn.started");
  const cancelled = types.indexOf("turn.cancelled");
  const waiting = types.indexOf("session.waiting");
  // A recovered worker may repeat the work, but it must not append a second
  // externally visible prefix for the same durable turn.
  for (const sourceEvent of [
    "session.started",
    "turn.started",
    "message.received",
    "step.started",
    "message.appended",
  ]) {
    expect(types.filter((type) => type === sourceEvent)).toHaveLength(1);
  }
  expect(types.filter((type) => type === "turn.cancelled")).toHaveLength(1);
  expect(types.filter((type) => type === "session.waiting")).toHaveLength(1);
  expect(started).toBeGreaterThanOrEqual(0);
  expect(cancelled).toBeGreaterThan(started);
  expect(waiting).toBeGreaterThan(cancelled);
  expect(waiting).toBe(types.length - 1);
  for (const forbidden of [
    "message.completed",
    "step.completed",
    "turn.completed",
    "turn.failed",
    "session.failed",
  ]) {
    expect(types).not.toContain(forbidden);
  }
}

function createDirectCancellationProbe(): {
  abort(): void;
  readonly abortCalls: number;
  readonly events: readonly string[];
  readonly listenerRemoved: boolean;
  readonly stream: ReadableStream<never>;
} {
  const abortController = new AbortController();
  const events: string[] = [];
  let abortCalls = 0;
  let listenerRemoved = false;
  let settled = false;
  const onAbort = () => {
    abortCalls += 1;
    settle("abort");
  };
  const settle = (reason: "abort" | "cancel") => {
    if (settled) return;
    settled = true;
    abortController.signal.removeEventListener("abort", onAbort);
    listenerRemoved = true;
    events.push(reason, "settled");
  };
  const stream = new ReadableStream<never>({
    start() {
      abortController.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      events.push("underlying-cancel");
      settle("cancel");
    },
  });

  return {
    abort() {
      abortController.abort(new Error("duplicate cancellation probe"));
    },
    get abortCalls() {
      return abortCalls;
    },
    events,
    get listenerRemoved() {
      return listenerRemoved;
    },
    stream,
  };
}

async function readThroughSessionWaiting(
  iterator: AsyncIterator<MessageStreamEvent>,
  events: MessageStreamEvent[],
): Promise<{
  readonly close: () => Promise<void>;
  readonly expectNoEvent: () => Promise<void>;
}> {
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error("Recovered public stream ended before session.waiting.");
    events.push(next.value);
    if (next.value.type !== "session.waiting") continue;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const closing = iterator.return?.();
      if (closing === undefined) return;
      // Some transport iterators wait for the peer to close. The caller's
      // server shutdown is that peer closure, so this only bounds cleanup.
      await Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    };
    return {
      close,
      async expectNoEvent() {
        const next = iterator.next().then((result) => ({ kind: "next" as const, result }));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          next,
          new Promise<{ readonly kind: "quiet" }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "quiet" }), 250);
          }),
        ]);
        if (timeout !== undefined) clearTimeout(timeout);
        if (outcome.kind === "next") {
          throw new Error(
            outcome.result.done
              ? "Recovered public stream ended after session.waiting."
              : `Public stream emitted ${outcome.result.value.type} after session.waiting.`,
          );
        }
        await close();
      },
    };
  }
}

function expectCompletedLifecycle(events: readonly MessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
  expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
  expect(types.filter((type) => type === "session.waiting")).toHaveLength(1);
  expect(types.at(-1)).toBe("session.waiting");
  expect(types).not.toContain("turn.cancelled");
  expect(types).not.toContain("turn.failed");
  expect(types).not.toContain("session.failed");
}

async function startRendezvous(): Promise<Rendezvous> {
  const nonce = randomUUID();
  const events: ProviderEvent[] = [];
  const reports: Array<{ readonly attempt: number; readonly event: ProviderEvent }> = [];
  const waiters = new Map<ProviderEvent, Array<() => void>>();
  const attemptWaiters = new Map<string, Array<() => void>>();
  const reportWaiters: Array<{
    readonly matches: (report: {
      readonly attempt: number;
      readonly event: ProviderEvent;
    }) => boolean;
    readonly resolve: (report: { readonly attempt: number; readonly event: ProviderEvent }) => void;
  }> = [];
  let released = false;
  let firstDeltaAllowed = false;
  const releaseWaiters: Array<() => void> = [];
  const firstDeltaWaiters: Array<() => void> = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("nonce") !== nonce) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/event") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        const event = JSON.parse(body) as {
          readonly attempt?: unknown;
          readonly event?: ProviderEvent;
        };
        if (event.event === undefined) return response.writeHead(400).end();
        events.push(event.event);
        const report = {
          attempt: typeof event.attempt === "number" ? event.attempt : 1,
          event: event.event,
        };
        reports.push(report);
        for (let index = reportWaiters.length - 1; index >= 0; index -= 1) {
          const waiter = reportWaiters[index];
          if (waiter === undefined || !waiter.matches(report)) continue;
          reportWaiters.splice(index, 1);
          waiter.resolve(report);
        }
        const attemptKey = `${event.event}:${String(event.attempt ?? 1)}`;
        for (const resolve of attemptWaiters.get(attemptKey) ?? []) resolve();
        attemptWaiters.delete(attemptKey);
        for (const resolve of waiters.get(event.event) ?? []) resolve();
        waiters.delete(event.event);
        response.writeHead(204).end();
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/release") {
      const finish = () => response.writeHead(204).end();
      if (released) finish();
      else releaseWaiters.push(finish);
      return;
    }
    if (request.method === "GET" && url.pathname === "/first-delta") {
      const finish = () => response.writeHead(204).end();
      if (firstDeltaAllowed) finish();
      else firstDeltaWaiters.push(finish);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a loopback rendezvous port.");

  return {
    allowFirstDelta() {
      if (firstDeltaAllowed) return;
      firstDeltaAllowed = true;
      for (const resolve of firstDeltaWaiters.splice(0)) resolve();
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    events,
    reports,
    nonce,
    release() {
      if (released) return;
      released = true;
      for (const resolve of releaseWaiters.splice(0)) resolve();
    },
    url: `http://127.0.0.1:${String(address.port)}`,
    waitFor(event) {
      if (events.includes(event)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const pending = waiters.get(event) ?? [];
        pending.push(resolve);
        waiters.set(event, pending);
      });
    },
    waitForAttempt(event, attempt) {
      if (reports.some((report) => report.event === event && report.attempt === attempt))
        return Promise.resolve();
      return new Promise<void>((resolve) => {
        const key = `${event}:${String(attempt)}`;
        const pending = attemptWaiters.get(key) ?? [];
        pending.push(resolve);
        attemptWaiters.set(key, pending);
      });
    },
    waitForReport(matches) {
      const report = reports.find(matches);
      if (report !== undefined) return Promise.resolve(report);
      return new Promise((resolve) => reportWaiters.push({ matches, resolve }));
    },
  };
}

async function withinDeadline<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const finiteAgentSource = `import { defineAgent } from "eve";
import { MockLanguageModelV3 } from "ai/test";

const model = new MockLanguageModelV3({
  modelId: "finite-stream",
  provider: "eve-test",
  doStream: async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ id: "finite-text", type: "text-start" });
        controller.enqueue({ delta: "complete", id: "finite-text", type: "text-delta" });
        controller.enqueue({ id: "finite-text", type: "text-end" });
        controller.enqueue({
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
        });
        controller.close();
      },
    }),
  }),
});

export default defineAgent({ model, modelContextWindowTokens: 8_192 });
`;

const heldAgentSource = `import { defineAgent } from "eve";
import { MockLanguageModelV3 } from "ai/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const base = process.env.EVE_TEST_RENDEZVOUS_URL;
const nonce = process.env.EVE_TEST_RENDEZVOUS_NONCE;
if (base === undefined || nonce === undefined) throw new Error("Missing test rendezvous.");

const url = (path: string) => \`${"${base}"}\${path}?nonce=\${encodeURIComponent(nonce)}\`;
const nextAttempt = () => {
  const attemptPath = ".task7-provider-attempt";
  const previousAttempt = existsSync(attemptPath) ? Number.parseInt(readFileSync(attemptPath, "utf8"), 10) : 0;
  const attempt = Number.isSafeInteger(previousAttempt) ? previousAttempt + 1 : 1;
  writeFileSync(attemptPath, String(attempt));
  return attempt;
};
const report = async (event: string, attempt: number) => {
  await fetch(url("/event"), { body: JSON.stringify({ attempt, event }), headers: { "content-type": "application/json" }, method: "POST" });
};

const model = new MockLanguageModelV3({
  modelId: "held-stream",
  provider: "eve-test",
  doStream: async ({ abortSignal }) => {
    const attempt = nextAttempt();
    const reportAttempt = (event: string) => report(event, attempt);
    return {
    stream: (() => {
      let settled = false;
      let controller: ReadableStreamDefaultController<any> | undefined;
      let abort: (() => void) | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const settle = (event: "interrupted" | "completed" | "watchdog", failure?: unknown, terminalize = true) => {
        if (settled) return;
        settled = true;
        if (watchdog !== undefined) clearTimeout(watchdog);
        if (abort !== undefined) abortSignal?.removeEventListener("abort", abort);
        void reportAttempt(event);
        void reportAttempt("listener-settled");
        if (terminalize && controller !== undefined) {
          if (failure !== undefined) controller.error(failure);
          else if (event === "completed") {
            controller.enqueue({ id: "held-text", type: "text-end" });
            controller.enqueue({ finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } } });
            controller.close();
          } else controller.error(new Error("provider interrupted"));
        }
        void reportAttempt("stream-settled");
      };
      return new ReadableStream({
      start(nextController) {
        controller = nextController;
        void reportAttempt("stream-start");
        abort = () => settle("interrupted", abortSignal?.reason);
        abortSignal?.addEventListener("abort", abort, { once: true });
        watchdog = setTimeout(() => settle("watchdog", new Error("provider hold timed out")), 5_000);
        void reportAttempt("handler-ready")
          .then(() => reportAttempt("first-delta-gate"))
          .then(() => fetch(url("/first-delta")))
          .then(() => {
            if (settled) return;
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ id: "held-text", type: "text-start" });
            controller.enqueue({ delta: "pending", id: "held-text", type: "text-delta" });
            return reportAttempt("first-delta").then(() => fetch(url("/release"))).then(() => settle("completed"));
          })
          .catch((error: unknown) => settle("watchdog", error));
      },
      cancel() {
        // Reader cancellation owns terminalization, so do not call
        // controller.error() on an already-cancelled underlying stream.
        void reportAttempt("underlying-cancel");
        settle("interrupted", undefined, false);
      },
    });
    })(),
    };
  },
});

export default defineAgent({ model, modelContextWindowTokens: 8_192 });
`;
