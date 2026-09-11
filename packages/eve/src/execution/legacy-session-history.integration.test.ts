import { describe, expect, it } from "vitest";

import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  createSession,
  hydrateDurableSession,
  projectToDurableSession,
} from "#execution/session.js";
import { migrateDurableSessionSnapshot } from "#execution/durable-session-migrations/snapshot.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { genAiInputMessagesAttribute } from "#tracing/agent-otel-content.js";

const turnAgent = {
  id: "test-agent",
  instructions: ["Be concise."],
  model: { id: "test-model" },
  tools: [],
  workspaceSpec: { rootEntries: [] },
};

describe("pre-0.54 durable history", () => {
  it("restores old user and framework messages without inventing provenance", async () => {
    const attachment = new URL("https://example.com/report.pdf");
    const history = [
      { role: "user", content: "Please summarize the report." },
      { role: "user", content: "A background task completed." },
      {
        role: "user",
        content: [{ type: "file", data: attachment, mediaType: "application/pdf" }],
        metadata: { retained: true },
      },
      { role: "assistant", content: "Here is the summary." },
      { role: "user", kind: "context.instruction", content: "Be concise." },
    ];
    const initial = createSession({
      continuationToken: "test-token",
      sessionId: "test-session",
      turnAgent,
    });
    const state = createDurableSessionState({ session: initial });
    const snapshot = migrateDurableSessionSnapshot({
      ...state.snapshot,
      session: { ...projectToDurableSession(initial), history },
      retained: "snapshot field",
    });
    const durable = await readDurableSession({ ...state, snapshot });
    const resumed = hydrateDurableSession({ durable, turnAgent });

    expect(resumed.history).toEqual([
      ...history.slice(0, 3).map((message) => ({ ...message, kind: "legacy.unknown" })),
      ...history.slice(3),
    ]);
    expect(history[0]).not.toHaveProperty("kind");
    expect(snapshot).toHaveProperty("retained", "snapshot field");
    expect(genAiInputMessagesAttribute(resumed.history)).toContain('"kind":"legacy.unknown"');
    const saved = createDurableSessionState({ session: resumed });
    expect(saved.version).toBe(state.version);
    expect(saved.snapshot?.version).toBe(state.snapshot?.version);
    expect(await readDurableSession(saved)).toEqual(durable);
  });

  it("does not repair malformed explicit kinds or relax new-message validation", () => {
    expect(() => validateHarnessModelMessages([{ role: "user", content: "New input" }])).toThrow(
      "Expected every user-role model message to have a kind.",
    );
    expect(() =>
      migrateDurableSessionSnapshot({
        version: 1,
        session: { history: [{ role: "user", kind: "invalid", content: "Old input" }] },
      }),
    ).toThrow("Expected every user-role model message to have a kind.");
  });
});
