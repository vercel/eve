import { describe, expect, it } from "vitest";

import { SESSION_CHECKPOINT_VERSION } from "#execution/session/checkpoint.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import type { SessionState } from "./session-store.js";
import { createWorldSessionStore } from "./world-store.js";

// A session's saves on its World: the first whole, then the changes after it (the history
// messages each step added, and the rest whole), whole again after a rewritten history or every
// 25th save. Loading applies the changes, so a session loads as it was last saved.

const sessionId = "session_01M6M9ZZZZZZZZZZZZZZZZZZZZ";

function stateWith(history: readonly string[], step: number): SessionState {
  // The session's own state and messages are opaque to the store: any JSON stands in for them.
  const sessionState: SessionState["checkpoint"]["sessionState"] = JSON.parse(
    JSON.stringify({ step }),
  );
  const messages: SessionState["checkpoint"]["history"] = JSON.parse(
    JSON.stringify(history.map((text) => ({ content: text, role: "user" }))),
  );
  return {
    checkpoint: {
      admittedDeliveryKeys: [],
      history: messages,
      serializedContext: {},
      sessionState,
      sessionTimeoutMs: false,
      version: SESSION_CHECKPOINT_VERSION,
    },
    format: "eve.in-process-session/2",
    sessionId,
    takenAt: new Date(1_800_000_000_000 + step).toISOString(),
  };
}

async function kinds(world: ReturnType<typeof memoryWorld>): Promise<string[]> {
  const page = await world.events.list({
    pagination: { limit: 1000, sortOrder: "asc" },
    resolveData: "all",
    runId: sessionId.replace(/^session_/, "wrun_"),
  });
  return page.data.flatMap((event) => {
    const stepName = (event.eventData as { readonly stepName?: unknown } | undefined)?.stepName;
    return event.eventType === "step_created" && typeof stepName === "string" ? [stepName] : [];
  });
}

describe("a session's saves on its World", () => {
  it("saves the changes after a whole state, and loads the state they add up to", async () => {
    const world = memoryWorld();
    const store = createWorldSessionStore(world);
    const history: string[] = [];
    for (let step = 0; step < 4; step++) {
      history.push(`message ${step}`);
      await store.saveState(stateWith(history, step));
    }
    expect((await kinds(world)).filter((kind) => kind !== "eve.claim")).toEqual([
      "eve.state",
      "eve.delta",
      "eve.delta",
      "eve.delta",
    ]);
    const loaded = await createWorldSessionStore(world).load(sessionId);
    expect(loaded).toEqual({ ...stateWith(history, 3), lines: [] });
  });

  it("saves the whole state when a step rewrote the history, as a compaction does", async () => {
    const world = memoryWorld();
    const store = createWorldSessionStore(world);
    await store.saveState(stateWith(["a", "b"], 0));
    await store.saveState(stateWith(["a", "b", "c"], 1));
    await store.saveState(stateWith(["summary of a, b, c"], 2));
    await store.saveState(stateWith(["summary of a, b, c", "d"], 3));
    expect(await kinds(world)).toEqual(["eve.state", "eve.delta", "eve.state", "eve.delta"]);
    expect((await store.load(sessionId))?.checkpoint.history).toEqual(
      stateWith(["summary of a, b, c", "d"], 3).checkpoint.history,
    );
  });

  it("saves the whole state again every 25th save", async () => {
    const world = memoryWorld();
    const store = createWorldSessionStore(world);
    const history: string[] = [];
    for (let step = 0; step < 27; step++) {
      history.push(`message ${step}`);
      await store.saveState(stateWith(history, step));
    }
    const saves = await kinds(world);
    expect(saves.filter((kind) => kind === "eve.state")).toHaveLength(2);
    expect(saves[26]).toBe("eve.state");
    expect((await createWorldSessionStore(world).load(sessionId))?.checkpoint.history).toHaveLength(
      27,
    );
  });
});
