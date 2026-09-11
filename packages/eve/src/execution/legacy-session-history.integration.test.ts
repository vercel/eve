import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { migrateDurableSessionSnapshot } from "#execution/durable-session-migrations/snapshot.js";
import {
  createDurableSessionState,
  type DurableSessionSnapshot,
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
    const legacySession = { ...projectToDurableSession(initial) };
    delete legacySession.userMessageKindVersion;
    const legacySnapshot = {
      ...state.snapshot,
      retained: "snapshot field",
      session: { ...legacySession, history },
    } as DurableSessionSnapshot;

    const durable = await readDurableSession({ ...state, snapshot: legacySnapshot });
    expect(durable.history[0]).not.toHaveProperty("kind");
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
    expect(saved.snapshot?.session.userMessageKindVersion).toBe(1);
    expect((await readDurableSession(saved)).history).toEqual(resumed.history);

    const migrated = migrateDurableSessionSnapshot(legacySnapshot);
    expect(migrated).toBe(legacySnapshot);
    expect(migrated).toHaveProperty("retained", "snapshot field");
  });

  it("does not repair malformed explicit kinds or relax new-message validation", () => {
    expect(() => validateHarnessModelMessages([{ content: "New input", role: "user" }])).toThrow(
      "Expected every user-role model message to have a kind.",
    );
    const malformed: ModelMessage = { content: "Old input", role: "user" };
    Reflect.set(malformed, "kind", "invalid");
    expect(() =>
      validateHarnessModelMessages([malformed], { missingUserKind: "legacy.unknown" }),
    ).toThrow("Expected every user-role model message to have a kind.");

    const initial = createSession({
      continuationToken: "test-token",
      sessionId: "test-session",
      turnAgent,
    });
    const durable = projectToDurableSession(initial);
    Reflect.set(durable, "history", [{ content: "Current input", role: "user" }]);
    expect(() =>
      hydrateDurableSession({
        durable,
        turnAgent,
      }),
    ).toThrow("Expected every user-role model message to have a kind.");
  });
});
