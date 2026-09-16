import { describe, expect, it } from "vitest";
import { importConversation, normalizeHistory } from "./snapshot.js";
import type { LegacySession } from "./snapshot.js";
describe("conversation import", () => {
  it("preserves authored state, budget, emission coordinates and storage", () => {
    const session: LegacySession = {
      sessionId: "old",
      continuationToken: "slack:thread",
      history: [{ role: "user", content: "Alice chose blue." }],
      agent: { system: "old prompt" },
      limits: { maxInputTokensPerSession: 40 },
      sandboxState: { initialized: false, session: null },
      state: {
        "app.color": "blue",
        "eve.runtime.pendingCoordinationBatch": { callId: "old" },
        "eve.agent.handles": { handles: [] },
        "eve.harness.turnUsage": { session: { inputTokens: 42 } },
        "eve.harness.emission": {
          sequence: 9,
          stepIndex: 3,
          turnId: "turn_8",
          sessionStarted: true,
        },
      },
    };
    const result = importConversation(session);
    expect(result.snapshot.session).toMatchObject({
      sessionId: "old",
      limits: session.limits,
      sandboxState: session.sandboxState,
      state: {
        "app.color": "blue",
        "eve.harness.turnUsage": session.state!["eve.harness.turnUsage"],
      },
    });
    expect(result.snapshot.session.state).not.toHaveProperty(
      "eve.runtime.pendingCoordinationBatch",
    );
    expect(result.snapshot.session.state).not.toHaveProperty("eve.agent.handles");
    expect(result.emissionState.sequence).toBe(9);
    expect(result.snapshot.session.history[0]).toMatchObject({
      kind: "user",
      content: "Alice chose blue.",
    });
  });
  it("settles unfinished tool calls without repeating completed calls", () => {
    const history = normalizeHistory([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "a", toolName: "work", input: {} },
          { type: "tool-call", toolCallId: "b", toolName: "work", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "work",
            output: { type: "text", value: "done" },
          },
        ],
      },
      { role: "user", content: "Bob asks for an update." },
    ]);
    expect(history).toHaveLength(4);
    expect(history[2]).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "b", output: { type: "error-text" } }],
    });
    expect(history[3]).toMatchObject({ role: "user", content: "Bob asks for an update." });
  });
  it("removes abandoned approval requests and settles their tool calls", () => {
    const history = normalizeHistory([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call", toolName: "work", input: {} },
          { type: "tool-approval-request", approvalId: "approval", toolCallId: "call" },
        ],
      },
    ]);
    expect(JSON.stringify(history)).not.toContain("approval");
    expect(history[1]).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "call", output: { type: "error-text" } }],
    });
  });
});
