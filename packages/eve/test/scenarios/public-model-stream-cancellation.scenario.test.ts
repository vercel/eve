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
  | "first-delta"
  | "interrupted"
  | "completed"
  | "listener-settled"
  | "stream-settled"
  | "watchdog";

interface Rendezvous {
  close(): Promise<void>;
  readonly events: readonly ProviderEvent[];
  readonly nonce: string;
  allowFirstDelta(): void;
  release(): void;
  readonly url: string;
  waitFor(event: ProviderEvent): Promise<void>;
}

describe("public model-stream cancellation", () => {
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
    expectCancelledLifecycle(result.events);
  }, 120_000);

  it("recovers the cancelled public session after an Eve process restart", async () => {
    const result = await runHeldProviderScenario({ cancel: "exact", restartAfterCancel: true });

    expectCancelledLifecycle(result.events);
  }, 120_000);
});

async function runHeldProviderScenario(input: {
  readonly cancel: "exact" | "omitted" | "wrong" | "duplicate" | "pre-delta";
  readonly restartAfterCancel?: boolean;
}): Promise<{
  readonly cancelResults: Array<{ readonly sessionId?: string; readonly status: string }>;
  readonly events: MessageStreamEvent[];
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
    if (input.cancel === "pre-delta") {
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
    if (
      cancelResults.some(
        (result) => result.status !== "accepted" || result.sessionId !== session.state.sessionId,
      )
    ) {
      throw new Error("Cancellation acknowledgement did not bind the active public session.");
    }
    return { cancelResults, events, rendezvous, sessionId: session.state.sessionId };
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
  expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
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
  const waiters = new Map<ProviderEvent, Array<() => void>>();
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
        const event = JSON.parse(body) as { readonly event?: ProviderEvent };
        if (event.event === undefined) return response.writeHead(400).end();
        events.push(event.event);
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

const base = process.env.EVE_TEST_RENDEZVOUS_URL;
const nonce = process.env.EVE_TEST_RENDEZVOUS_NONCE;
if (base === undefined || nonce === undefined) throw new Error("Missing test rendezvous.");

const url = (path: string) => \`${"${base}"}\${path}?nonce=\${encodeURIComponent(nonce)}\`;
const report = async (event: string) => {
  await fetch(url("/event"), { body: JSON.stringify({ event }), headers: { "content-type": "application/json" }, method: "POST" });
};

const model = new MockLanguageModelV3({
  modelId: "held-stream",
  provider: "eve-test",
  doStream: async ({ abortSignal }) => ({
    stream: new ReadableStream({
      start(controller) {
        let settled = false;
        const settle = (event: "interrupted" | "completed" | "watchdog", failure?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          abortSignal?.removeEventListener("abort", abort);
          void report(event);
          void report("listener-settled");
          if (failure !== undefined) controller.error(failure);
          else if (event === "completed") {
            controller.enqueue({ id: "held-text", type: "text-end" });
            controller.enqueue({ finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } } });
            controller.close();
          } else controller.error(new Error("provider interrupted"));
          void report("stream-settled");
        };
        const abort = () => settle("interrupted", abortSignal?.reason);
        abortSignal?.addEventListener("abort", abort, { once: true });
        const watchdog = setTimeout(() => settle("watchdog", new Error("provider hold timed out")), 5_000);
        void report("handler-ready")
          .then(() => fetch(url("/first-delta")))
          .then(() => {
            if (settled) return;
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ id: "held-text", type: "text-start" });
            controller.enqueue({ delta: "pending", id: "held-text", type: "text-delta" });
            return report("first-delta").then(() => fetch(url("/release"))).then(() => settle("completed"));
          })
          .catch((error: unknown) => settle("watchdog", error));
      },
      cancel() {
        // This reports provider-side reader cancellation without creating Eve lifecycle events.
        settle("interrupted", new Error("provider reader cancelled"));
      },
    }),
  }),
});

export default defineAgent({ model, modelContextWindowTokens: 8_192 });
`;
