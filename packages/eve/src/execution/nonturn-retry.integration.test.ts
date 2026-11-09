import type { AnyEventRequest } from "@workflow/world";
import { expect, it, vi } from "vitest";
import { streamSessionEvents } from "#execution/session-event-stream.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import {
  nonturnRetryWorkflow,
  beforePublicationRetryWorkflow,
  terminalAfterStaleCheckpointWorkflow,
  commitTwiceWorkflow,
  progressWindowRetryWorkflow,
  lessOnRetryWorkflow,
} from "#internal/testing/nonturn-retry-workflow.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic } from "#public/definitions/connections/dynamic.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { loadContext } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection.js";

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
    const run = await start(nonturnRetryWorkflow, [
      buildSerializedContext({ channelKind: "http" }),
    ]);
    expect(await run.returnValue).toBe(run.runId);
    const events = [];
    for await (const event of streamSessionEvents(run.runId, { follow: false })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["session.started", "turn.started"]);
    expect(resolutions).toBe(0);
  });
}, 60_000);

it("adopts both commits of a step that commits twice and loses its checkpoint", async () => {
  const runtime = await createTestRuntime({ agent: { name: "commit-twice-retry" } });
  await runtime.run(async () => {
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const createEvent = world.events.create.bind(world.events);
    let sessionId: string | undefined;
    let interrupted = false;
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [runId, event] = args as [string, AnyEventRequest];
      if (!interrupted && runId === sessionId && event.eventType === "step_completed") {
        interrupted = true;
        throw new Error("Lost the two-commit step checkpoint");
      }
      return await createEvent(...args);
    });
    try {
      const run = await start(commitTwiceWorkflow, [
        buildSerializedContext({ channelKind: "http" }),
      ]);
      sessionId = run.runId;
      expect(await run.returnValue).toBe(run.runId);
      expect(interrupted).toBe(true);
      const events = [];
      for await (const event of streamSessionEvents(run.runId, { follow: false }))
        events.push(event);
      expect(events.map((event) => [event.type, event.meta.position.line])).toEqual([
        ["session.started", 0],
        ["turn.started", 1],
      ]);
    } finally {
      spy.mockRestore();
      world.events.createBatch = createBatch;
    }
  });
}, 60_000);

it("adopts an interrupted progress step even when its checkpoint is far from the last commit", async () => {
  const runtime = await createTestRuntime({ agent: { name: "bounded-progress" } });
  await runtime.run(async () => {
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const createEvent = world.events.create.bind(world.events);
    let sessionId: string | undefined;
    let completed = 0;
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [runId, event] = args as [string, AnyEventRequest];
      if (runId === sessionId && event.eventType === "step_completed" && ++completed === 4)
        throw new Error("Lost progress checkpoint");
      return await createEvent(...args);
    });
    try {
      const run = await start(progressWindowRetryWorkflow, [
        buildSerializedContext({ channelKind: "http" }),
      ]);
      sessionId = run.runId;
      expect(await run.returnValue).toBe(run.runId);
      expect(completed).toBeGreaterThanOrEqual(4);
      const events = [];
      for await (const event of streamSessionEvents(run.runId, { follow: false }))
        events.push(event);
      expect(events.filter((event) => event.type === "session.ended")).toHaveLength(0);
      expect(events.filter((event) => event.type === "call.progress")).toHaveLength(258);
    } finally {
      spy.mockRestore();
      world.events.createBatch = createBatch;
    }
  });
}, 90_000);

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
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const createEvent = world.events.create.bind(world.events);
    let sessionId: string | undefined;
    let interrupted = false;
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [runId, event] = args as [string, AnyEventRequest];
      if (!interrupted && runId === sessionId && event.eventType === "step_completed") {
        interrupted = true;
        throw new Error("Process exited after non-turn publication");
      }
      return await createEvent(...args);
    });
    try {
      const run = await start(nonturnRetryWorkflow, [
        buildSerializedContext({ channelKind: "http" }),
      ]);
      sessionId = run.runId;
      expect(await run.returnValue).toBe(sessionId);
      expect(interrupted).toBe(true);
      expect(positions).toEqual([0]);
      const events = [];
      for await (const event of streamSessionEvents(sessionId, { follow: false }))
        events.push(event);
      expect(events.map((event) => [event.type, event.meta.position.line])).toEqual([
        ["session.started", 0],
        ["turn.started", 1],
      ]);
    } finally {
      spy.mockRestore();
      world.events.createBatch = createBatch;
    }
  });
}, 60_000);

it("retries a transient step failure when nothing was published", async () => {
  const runtime = await createTestRuntime({ agent: { name: "before-publication-retry" } });
  await runtime.run(async () => {
    const run = await start(beforePublicationRetryWorkflow, [
      buildSerializedContext({ channelKind: "http" }),
    ]);
    expect(await run.returnValue).toBe(run.runId);
    const events = [];
    for await (const event of streamSessionEvents(run.runId, { follow: false })) events.push(event);
    expect(events.map(({ type }) => type)).toEqual(["session.started"]);
  });
}, 60_000);

it.each([true, "unreadable"] as const)(
  "writes a terminal closure at the physical tail when providers cannot restore (%s)",
  async (providers) => {
    const runtime = await createTestRuntime({ agent: { name: "terminal-fallback" } });
    await runtime.run(async () => {
      const run = await start(terminalAfterStaleCheckpointWorkflow, [
        buildSerializedContext({ channelKind: "http" }),
        providers,
      ]);
      expect(await run.returnValue).toBe(run.runId);
      const events = [];
      for await (const event of streamSessionEvents(run.runId, { follow: false }))
        events.push(event);
      expect(events.map((event) => [event.type, event.meta.position.line])).toEqual([
        ["session.started", 0],
        ["turn.started", 1],
        ["turn.settled", 2],
        ["session.ended", 2],
      ]);
    });
  },
  60_000,
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
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const createEvent = world.events.create.bind(world.events);
    let completed = 0;
    let interrupted = false;
    let closes = 0;
    const getWriter = WritableStream.prototype.getWriter;
    const closeSpy = vi.spyOn(WritableStream.prototype, "getWriter").mockImplementation(function (
      this: WritableStream<Uint8Array>,
    ) {
      const writer = getWriter.call(this);
      const close = writer.close.bind(writer);
      writer.close = async () => {
        closes++;
        if (interrupted) throw new Error("Previously closed writer rejects duplicate closure");
        return await close();
      };
      return writer;
    });
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [, event] = args as [string, AnyEventRequest];
      if (event.eventType === "step_completed" && ++completed === 3) {
        interrupted = true;
        throw new Error("Process exited after terminal publication");
      }
      return await createEvent(...args);
    });
    try {
      const run = await start(terminalAfterStaleCheckpointWorkflow, [
        buildSerializedContext({ channelKind: "http" }),
      ]);
      expect(await run.returnValue).toBe(run.runId);
      expect(interrupted).toBe(true);
      expect(closes).toBeGreaterThanOrEqual(2);
      const events = [];
      for await (const event of streamSessionEvents(run.runId, { follow: false }))
        events.push(event);
      expect(events.filter((event) => event.type === "session.ended")).toHaveLength(1);
      expect(terminalHooks).toBe(0);
    } finally {
      spy.mockRestore();
      closeSpy.mockRestore();
      world.events.createBatch = createBatch;
    }
  });
}, 60_000);

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
    const run = await start(terminalAfterStaleCheckpointWorkflow, [
      buildSerializedContext({ channelKind: "http" }),
    ]);
    expect(await run.returnValue).toBe(run.runId);
    const events = [];
    for await (const event of streamSessionEvents(run.runId, { follow: false })) events.push(event);
    expect(events.map((event) => [event.type, event.meta.position.line])).toEqual([
      ["session.started", 0],
      ["turn.started", 1],
      ["turn.settled", 2],
      ["session.ended", 2],
    ]);
    expect(positions).toEqual([1]);
    expect(connections).toEqual([[]]);
  });
}, 60_000);

it.each(["prefix", "none"] as const)(
  "follows the orphan tail when a retry writes %s, so the next step writes after it",
  async (replay) => {
    const runtime = await createTestRuntime({ agent: { name: "less-on-retry" } });
    await runtime.run(async () => {
      const run = await start(lessOnRetryWorkflow, [
        buildSerializedContext({ channelKind: "http" }),
        replay,
      ]);
      expect(await run.returnValue).toBe(run.runId);
      const events = [];
      for await (const event of streamSessionEvents(run.runId, { follow: false }))
        events.push(event);
      expect(events.map((event) => [event.type, event.meta.position.line])).toEqual([
        ["session.started", 0],
        ["turn.started", 1],
        ["turn.settled", 2],
      ]);
    });
  },
  60_000,
);
