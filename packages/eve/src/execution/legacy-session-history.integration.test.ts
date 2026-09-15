import { describe, expect, it } from "vitest";

import { migrateDurableSessionSnapshot } from "#execution/durable-session-migrations/snapshot.js";
import {
  createDurableSessionState,
  MODEL_MESSAGE_FORMAT_VERSION,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  createSession,
  hydrateDurableSession,
  projectToDurableSession,
} from "#execution/session.js";
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
      { content: "Please summarize the report.", role: "user" },
      { content: "A background task completed.", role: "user" },
      {
        content: [{ data: attachment, mediaType: "application/pdf", type: "file" }],
        legacyField: "retained",
        metadata: { retained: true },
        role: "user",
      },
      { content: "Here is the summary.", role: "assistant" },
      { content: "Be concise.", kind: "context.instruction", role: "user" },
    ];
    const initial = createSession({
      continuationToken: "test-token",
      sessionId: "test-session",
      turnAgent,
    });
    const state = createDurableSessionState({ session: initial });
    const { modelMessageFormatVersion: _modelMessageFormatVersion, ...legacySnapshotEnvelope } =
      state.snapshot!;
    const legacySnapshot = {
      ...legacySnapshotEnvelope,
      retained: "snapshot field",
      session: { ...projectToDurableSession(initial), history },
    };
    const legacyState = { ...state };
    Reflect.set(legacyState, "snapshot", legacySnapshot);

    const durable = await readDurableSession(legacyState);
    const resumed = hydrateDurableSession({ durable, turnAgent });

    expect(resumed.history).toEqual([
      ...history.slice(0, 3).map((message) => ({ ...message, kind: "legacy.unknown" })),
      ...history.slice(3),
    ]);
    expect(history[0]).not.toHaveProperty("kind");
    expect(genAiInputMessagesAttribute(resumed.history)).toContain('"kind":"legacy.unknown"');

    const saved = createDurableSessionState({ session: resumed });
    expect(saved.version).toBe(state.version);
    expect(saved.snapshot?.version).toBe(state.snapshot?.version);
    expect(saved.snapshot?.modelMessageFormatVersion).toBe(MODEL_MESSAGE_FORMAT_VERSION);
    const reread = await readDurableSession(saved);
    expect(reread).toBe(saved.snapshot?.session);
    expect(reread).toEqual(durable);

    const migrated = migrateDurableSessionSnapshot(legacySnapshot);
    expect(migrated).toHaveProperty("retained", "snapshot field");
    expect(migrated.modelMessageFormatVersion).toBe(MODEL_MESSAGE_FORMAT_VERSION);
  });

  it("does not repair malformed explicit kinds or relax new-message validation", () => {
    expect(() => validateHarnessModelMessages([{ content: "New input", role: "user" }])).toThrow(
      "Expected every user-role model message to have a kind.",
    );
    expect(() =>
      migrateDurableSessionSnapshot({
        session: {
          history: [{ content: "Old input", kind: "invalid", role: "user" }],
        },
        version: 1,
      }),
    ).toThrow("Expected every user-role model message to have a kind.");
  });
});
