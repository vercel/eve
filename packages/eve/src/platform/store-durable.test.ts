import { describe, expect, it, vi } from "vitest";

import { hookAddress, opaque } from "#execution/durable.js";
import { createMemorySessionStore as memoryStore } from "#internal/testing/session-host/memory-session-store.js";
import { testApp } from "#internal/testing/test-platform.js";
import { sessionSteps, storeDurable } from "#platform/engine.js";

describe("storeDurable start", () => {
  it("starts a session once when two starts with its ID race, and keeps its state", async () => {
    const store = memoryStore();
    const claim = vi.spyOn(store, "claim");
    const wake = vi.fn(async () => {});
    const { durable } = storeDurable({ store, wake });
    const start = {
      addresses: [hookAddress("alice")],
      body: opaque<"eve.session-start">({ note: "Alice's first start." }),
      sessionId: "session-alice",
    };

    const results = await Promise.all([durable.start(start), durable.start(start)]);

    expect(results).toEqual([
      { kind: "started", sessionId: "session-alice" },
      { kind: "started", sessionId: "session-alice" },
    ]);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);

    await store.enqueue("session-alice", {
      body: { kind: "deliver", payload: { note: "Bob" }, to: hookAddress("alice") },
      id: "item-bob",
    });
    expect(
      await durable.start({ ...start, body: opaque<"eve.session-start">({ note: "Later." }) }),
    ).toEqual({ kind: "started", sessionId: "session-alice" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await store.loadRun("session-alice"))?.start.body).toEqual(start.body);
    expect(await store.itemsAfter("session-alice", 0, 10)).toHaveLength(1);
  });

  it("answers held, and never runs the session, when another session holds its address", async () => {
    const store = memoryStore();
    const wake = vi.fn(async (_sessionId: string) => {});
    const { durable } = storeDurable({ store, wake });
    const body = opaque<"eve.session-start">({ note: "Alice's thread." });
    const addresses = [hookAddress("alice-thread")];

    expect(await durable.start({ addresses, body, sessionId: "session-alice" })).toEqual({
      kind: "started",
      sessionId: "session-alice",
    });
    expect(await durable.start({ addresses, body, sessionId: "session-bob" })).toEqual({
      kind: "held",
    });

    expect(wake.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-alice"]);
    expect(await store.status("session-bob")).toBe("ended");
    expect(await durable.sessionFor(addresses[0]!)).toBe("session-alice");
  });

  it("names what a session can't run when the engine runs no child sessions", async () => {
    const steps = sessionSteps(testApp(), { streams: memoryStore().streams });
    const meta = { attempt: 1, key: "session-alice:dispatch", sessionId: "session-alice" };

    await expect(steps.run("dispatchRuns", {} as never, meta)).rejects.toThrow(
      "This durable engine runs no child sessions or workflow tools, so this session can't call the agent tool, a subagent, ask_question, or a workflow tool. Use an engine whose build sets runs: true, such as the Workflow engine.",
    );
  });
});
