// @linux-only: non-turn step retry adoption
import { expect, it, onTestFinished } from "vitest";
import { registerHost, registerSessionLineStore } from "#execution/hosts.js";
import { createMemoryLineStore } from "#execution/in-process/line-store.js";
import { createStepAttempts } from "#execution/in-process/step-attempts.js";
import { streamSessionEvents } from "#execution/session-event-stream.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import {
  commitTwice,
  initialValues,
  publishLessOnRetry,
  publishNext,
  publishProgress,
  publishRunning,
  publishStart,
  settleTurn,
  type TestStepAttempt,
} from "#internal/testing/nonturn-retry-steps.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic } from "#public/definitions/connections/dynamic.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { loadContext } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection.js";

// Non-turn session steps that lose their completion, or throw, and run again. Each test runs
// the attempts a durable host would, in process: what an attempt wrote stays on the session's
// stream, and the next attempt gets its own writable onto it and enters as a retry. The
// in-process host runs a session's non-turn steps inline, without attempts, so these drive the
// steps themselves.

let nextSession = 0;

/** A session's stream in memory, and a runner for the attempts of its steps. */
function sessionSteps() {
  const sessionId = `session-nonturn-${++nextSession}`;
  const lines = createMemoryLineStore();
  const stream = lines.open(sessionId);
  const attempts = createStepAttempts(undefined);
  const releases = [
    registerSessionLineStore(sessionId, lines),
    registerHost({
      deliver: async () => undefined,
      runEnded: () => undefined,
      cancelRun: () => undefined,
      stepAttempt: () => attempts.current(),
    }),
  ];
  onTestFinished(() => {
    for (const release of releases) release();
  });
  let closes = 0;
  /** A writable of the attempt's own onto the session's stream, as each Workflow step gets. */
  const writable = () => {
    const withWriter = async (
      use: (writer: WritableStreamDefaultWriter<Uint8Array>) => Promise<void>,
    ) => {
      const writer = stream.getWriter();
      try {
        await use(writer);
      } finally {
        writer.releaseLock();
      }
    };
    return new WritableStream<Uint8Array>({
      write: (chunk) => withWriter((writer) => writer.write(chunk)),
      close: () => {
        closes += 1;
        return withWriter((writer) => writer.close());
      },
    });
  };
  return {
    sessionId,
    closes: () => closes,
    /** Runs attempt `attempt` of a step; what it returns crosses as a copy. */
    async run<T>(attempt: number, body: (step: TestStepAttempt) => Promise<T>): Promise<T> {
      const result = await attempts.enter(attempt, () =>
        body({ attempt, sessionId, sessionWritable: writable() }),
      );
      return structuredClone(result);
    },
    /** Each event on the stream, as type and line. */
    async lines() {
      const events = [];
      for await (const event of streamSessionEvents(sessionId, { follow: false })) {
        events.push(event);
      }
      return events;
    },
  };
}

const context = () => buildSerializedContext({ channelKind: "http" });

it("does not run dynamic connection resolvers for ordinary non-turn publications", async () => {
  let resolutions = 0;
  const runtime = await createTestRuntime({
    agent: { name: "nonturn-normal-connection" },
    modules: [
      {
        logicalPath: "connections/dynamic.ts",
        loadNamespace: async () => ({
          default: defineDynamic(() => {
            resolutions++;
            return defineMcpClientConnection({
              url: "https://example.com/mcp",
              description: "Test binding",
            });
          }),
        }),
      },
    ],
  });
  await runtime.run(async () => {
    const session = sessionSteps();
    const started = await session.run(1, (step) => publishStart(step, context()));
    await session.run(1, (step) => publishNext(step, started));
    expect((await session.lines()).map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
    ]);
    expect(resolutions).toBe(0);
  });
});

it("adopts both commits of a step that commits twice and loses its checkpoint", async () => {
  const runtime = await createTestRuntime({ agent: { name: "commit-twice-retry" } });
  await runtime.run(async () => {
    const session = sessionSteps();
    await session.run(1, (step) => commitTwice(step, context()));
    await session.run(2, (step) => commitTwice(step, context()));
    expect((await session.lines()).map((event) => [event.type, event.meta.position.line])).toEqual([
      ["session.started", 0],
      ["turn.started", 1],
    ]);
  });
});

it("adopts an interrupted progress step even when its checkpoint is far from the last commit", async () => {
  const runtime = await createTestRuntime({ agent: { name: "bounded-progress" } });
  await runtime.run(async () => {
    const session = sessionSteps();
    const start = await session.run(1, (step) => publishStart(step, context()));
    const running = await session.run(1, (step) => publishRunning(step, start));
    const progressed = await session.run(1, (step) => publishProgress(step, running, 257));
    await session.run(1, (step) => publishProgress(step, progressed, 1));
    await session.run(2, (step) => publishProgress(step, progressed, 1));
    const events = await session.lines();
    expect(events.filter((event) => event.type === "session.ended")).toHaveLength(0);
    expect(events.filter((event) => event.type === "call.progress")).toHaveLength(258);
  });
});

it("adopts a non-turn publication without running its hooks again after its checkpoint is lost", async () => {
  const positions: number[] = [];
  const runtime = await createTestRuntime({
    agent: { name: "nonturn-retry" },
    modules: [
      {
        logicalPath: "hooks/audit.ts",
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "session.started"(_event, ctx) {
                positions.push(ctx.position.line);
              },
            },
          }),
        }),
      },
    ],
  });
  await runtime.run(async () => {
    const session = sessionSteps();
    await session.run(1, (step) => publishStart(step, context()));
    const started = await session.run(2, (step) => publishStart(step, context()));
    await session.run(1, (step) => publishNext(step, started));
    expect(positions).toEqual([0]);
    expect((await session.lines()).map((event) => [event.type, event.meta.position.line])).toEqual([
      ["session.started", 0],
      ["turn.started", 1],
    ]);
  });
});

it("runs a step again after a transient failure when nothing was published", async () => {
  const runtime = await createTestRuntime({ agent: { name: "before-publication-retry" } });
  await runtime.run(async () => {
    const session = sessionSteps();
    await expect(session.run(1, (step) => publishStart(step, context(), true))).rejects.toThrow(
      "Transient failure before publication",
    );
    await session.run(2, (step) => publishStart(step, context(), true));
    expect((await session.lines()).map(({ type }) => type)).toEqual(["session.started"]);
  });
});

/** Starts a turn, then ends the session from the checkpoint before it: a stale one. */
async function endFromStaleCheckpoint(
  session: ReturnType<typeof sessionSteps>,
  options: { readonly providers?: true | "unreadable"; readonly loseTerminal?: true } = {},
) {
  const started = await session.run(1, (step) => publishStart(step, context()));
  await session.run(1, (step) => publishNext(step, started));
  const terminal = (step: TestStepAttempt) =>
    emitTerminalSessionCompletionStep({
      ...started,
      ...(options.providers !== undefined && {
        serializedContext: {
          "eve.sessionId": session.sessionId,
          ...(options.providers === "unreadable" && { "eve.stateLayout": 0 }),
        },
      }),
      sessionWritable: step.sessionWritable,
      usage: undefined,
    });
  await session.run(1, terminal);
  if (options.loseTerminal) await session.run(2, terminal);
}

it.each([true, "unreadable"] as const)(
  "writes a terminal closure at the physical tail when providers cannot restore (%s)",
  async (providers) => {
    const runtime = await createTestRuntime({ agent: { name: "terminal-fallback" } });
    await runtime.run(async () => {
      const session = sessionSteps();
      await endFromStaleCheckpoint(session, { providers });
      expect(
        (await session.lines()).map((event) => [event.type, event.meta.position.line]),
      ).toEqual([
        ["session.started", 0],
        ["turn.started", 1],
        ["turn.settled", 2],
        ["session.ended", 2],
      ]);
    });
  },
);

it("adopts a terminal after its step checkpoint is lost", async () => {
  let terminalHooks = 0;
  const runtime = await createTestRuntime({
    agent: { name: "terminal-checkpoint-retry" },
    modules: [
      {
        logicalPath: "hooks/terminal.ts",
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "session.ended"() {
                terminalHooks++;
              },
            },
          }),
        }),
      },
    ],
  });
  await runtime.run(async () => {
    const session = sessionSteps();
    // The retry closes the stream again, which the closed stream refuses.
    await endFromStaleCheckpoint(session, { loseTerminal: true });
    expect(session.closes()).toBeGreaterThanOrEqual(2);
    const events = await session.lines();
    expect(events.filter((event) => event.type === "session.ended")).toHaveLength(1);
    expect(terminalHooks).toBe(0);
  });
});

it("folds orphan writes without redispatching hooks with uncheckpointed connections", async () => {
  const positions: number[] = [];
  const connections: string[][] = [];
  const runtime = await createTestRuntime({
    agent: { name: "terminal-orphan" },
    modules: [
      {
        logicalPath: "connections/dynamic.ts",
        loadNamespace: async () => ({
          default: defineDynamic(() =>
            defineMcpClientConnection({
              url: "https://example.com/mcp",
              description: "Local test binding",
            }),
          ),
        }),
      },
      {
        logicalPath: "hooks/audit.ts",
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "turn.started"(_event, ctx) {
                positions.push(ctx.position.line);
                connections.push([
                  ...loadContext().require(ConnectionRegistryKey).getConnectionNames(),
                ]);
              },
            },
          }),
        }),
      },
    ],
  });
  await runtime.run(async () => {
    const session = sessionSteps();
    await endFromStaleCheckpoint(session);
    expect((await session.lines()).map((event) => [event.type, event.meta.position.line])).toEqual([
      ["session.started", 0],
      ["turn.started", 1],
      ["turn.settled", 2],
      ["session.ended", 2],
    ]);
    expect(positions).toEqual([1]);
    expect(connections).toEqual([[]]);
  });
});

it.each(["prefix", "none"] as const)(
  "follows the orphan tail when a retry writes %s, so the next step writes after it",
  async (replay) => {
    const runtime = await createTestRuntime({ agent: { name: "less-on-retry" } });
    await runtime.run(async () => {
      const session = sessionSteps();
      const values = initialValues(session.sessionId, context());
      await expect(
        session.run(1, (step) => publishLessOnRetry(step, values, replay)),
      ).rejects.toThrow("Interrupted after publishing");
      const { stateDelta } = await session.run(2, (step) =>
        publishLessOnRetry(step, values, replay),
      );
      await session.run(1, (step) => settleTurn(step, applySessionStateDelta(values, stateDelta)));
      expect(
        (await session.lines()).map((event) => [event.type, event.meta.position.line]),
      ).toEqual([
        ["session.started", 0],
        ["turn.started", 1],
        ["turn.settled", 2],
      ]);
    });
  },
);
