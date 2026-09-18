import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import {
  applyTurnStepDelta,
  captureTurnStepState,
  createTurnStepDelta,
} from "./turn-step-delta.js";
import type { TurnStepState } from "./turn-step-types.js";

function state(): TurnStepState {
  return { serializedContext: { budget: { spent: 0 } }, sessionState: createTestSessionState() };
}

describe("turn step delta protocol", () => {
  it("reconstructs both cancellation branches against the invocation state", () => {
    const before = state();
    const completed = structuredClone(before);
    completed.sessionState.snapshot.session.history.push({
      role: "assistant",
      content: "Finished",
    });
    const background = structuredClone(before);
    background.sessionState.snapshot.session.history.push({
      role: "assistant",
      content: "Delegated",
    });
    const expected = {
      action: "cancelled" as const,
      ...completed,
      backgroundTaskState: background.sessionState,
      backgroundTaskContext: { budget: { spent: 1 } },
    };
    const output = createTurnStepDelta(captureTurnStepState(before), expected);
    expect(output).not.toHaveProperty("sessionState");
    expect(output).not.toHaveProperty("serializedContext");
    expect(output).not.toHaveProperty("backgroundTaskState");
    expect(applyTurnStepDelta(before, structuredClone(output))).toEqual(expected);
    expect(before.sessionState.snapshot.session.history).toEqual([]);
  });

  it("preserves an omitted background context so the owner retains its pre-step context", () => {
    const before = state();
    const result = {
      ...before,
      action: "cancelled" as const,
      serializedContext: { changed: true },
      backgroundTaskState: before.sessionState,
    };
    expect(
      applyTurnStepDelta(before, createTurnStepDelta(captureTurnStepState(before), result)),
    ).toEqual(result);
  });

  it("captures in-place updates before execution and preserves projection metadata", () => {
    const input = state();
    const replay = structuredClone(input);
    const captured = captureTurnStepState(input);
    (input.serializedContext.budget as { spent: number }).spent = 2;
    input.sessionState.snapshot.session.history.push({
      role: "user",
      kind: "user",
      content: "Hello",
    });
    const result = { action: "continue" as const, ...input };
    expect(applyTurnStepDelta(replay, createTurnStepDelta(captured, result))).toEqual(result);
  });

  it("rejects a different session or protocol version", () => {
    const before = state();
    const output = createTurnStepDelta(captureTurnStepState(before), { action: "done", ...before });
    expect(() => applyTurnStepDelta(before, { ...output, sessionId: "other" })).toThrow(
      "mismatched",
    );
    expect(() => applyTurnStepDelta(before, { ...output, version: 2 as 1 })).toThrow("Unsupported");
  });
});
