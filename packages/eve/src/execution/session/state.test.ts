import { describe, expect, it } from "vitest";

import { createSession, hydrateDurableSession } from "#execution/session.js";
import {
  createDurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/session/state.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

const turnAgent: RuntimeTurnAgent = {
  id: "agent",
  instructions: ["Current instructions"],
  model: { id: "model" },
  tools: [],
  workspaceSpec: { rootEntries: [] },
};

describe("session checkpoint state", () => {
  it("retains domain memory and rehydrates runtime agent definitions from the accepting deployment", async () => {
    const initial = createSession({ sessionId: "session", continuationToken: "alias", turnAgent });
    const state = createDurableSessionState({
      session: {
        ...initial,
        history: [{ role: "user", content: "Remember" }],
        state: { pending: { callId: "call" } },
      },
    });
    const durable = await readDurableSession(state);
    expect(durable.agent).toEqual({ system: "Current instructions" });
    expect(durable.agent).not.toHaveProperty("modelReference");
    const restored = hydrateDurableSession({
      durable,
      turnAgent: { ...turnAgent, model: { id: "new-model" } },
    });
    expect(restored.agent.modelReference?.id).toBe("new-model");
    expect(restored.history).toEqual([{ role: "user", content: "Remember" }]);
    expect(restored.state).toEqual({ pending: { callId: "call" } });
    expect(state).not.toHaveProperty("version");
  });

  it("recomputes control projections from the authoritative replacement snapshot", () => {
    const state = createDurableSessionState({
      session: createSession({ sessionId: "session", continuationToken: "old", turnAgent }),
    });
    const next = replaceDurableSessionSnapshot({
      state,
      session: { ...state.snapshot.session, continuationToken: "new" },
    });
    expect(next.continuationToken).toBe("new");
    expect(next.snapshot.session.continuationToken).toBe("new");
    expect(state.snapshot.session.continuationToken).toBe("old");
  });
});
