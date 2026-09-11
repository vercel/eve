import { describe, expect, it } from "vitest";

import { migrateDurableSessionSnapshot } from "#execution/durable-session-migrations/snapshot.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  createSession,
  hydrateDurableSession,
  projectToDurableSession,
} from "#execution/session.js";

const turnAgent = {
  id: "test-agent",
  instructions: ["Be concise."],
  model: { id: "test-model" },
  tools: [],
  workspaceSpec: { rootEntries: [] },
};

describe("pre-0.54 durable history", () => {
  it("restores a legacy user message with unknown provenance", async () => {
    const initial = createSession({
      continuationToken: "test-token",
      sessionId: "test-session",
      turnAgent,
    });
    const state = createDurableSessionState({ session: initial });
    const snapshot = migrateDurableSessionSnapshot({
      ...state.snapshot,
      session: {
        ...projectToDurableSession(initial),
        history: [{ content: "Please summarize the report.", role: "user" }],
      },
    });

    const durable = await readDurableSession({ ...state, snapshot });
    const resumed = hydrateDurableSession({ durable, turnAgent });

    expect(resumed.history).toEqual([
      { content: "Please summarize the report.", kind: "legacy.unknown", role: "user" },
    ]);
  });
});
