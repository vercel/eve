import { describe, expect, it, vi } from "vitest";

import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitTurnEpilogue,
  emitTurnPreamble,
} from "#harness/emission.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessSettlement } from "#harness/types.js";
import { createResultCompletedEvent } from "#protocol/message.js";

const state: HarnessEmissionState = {
  sessionStarted: true,
  sequence: 3,
  stepIndex: 2,
  turnId: "turn_owned",
};

describe("harness settlement proposals", () => {
  it("keeps the turn open and defers structured result plus terminal events before the event sink", async () => {
    const emit = vi.fn(async () => {});
    const settlements: HarnessSettlement[] = [];
    const after = await emitTurnEpilogue(
      emit,
      state,
      "conversation",
      async (proposal) => {
        settlements.push(proposal);
      },
      [
        createResultCompletedEvent({
          result: { answer: 42 },
          sequence: 3,
          stepIndex: 2,
          turnId: "turn_owned",
        }),
      ],
    );

    expect(after).toBe(state);
    expect(emit).not.toHaveBeenCalled();
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.events.map((event) => event.type)).toEqual([
      "result.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(settlements[0]?.emissionAfter).toEqual({
      sessionStarted: true,
      sequence: 4,
      stepIndex: 0,
      turnId: "",
    });
  });

  it("defers both recoverable and terminal failures before external lifecycle work", async () => {
    const emit = vi.fn(async () => {});
    const settle = vi.fn(async (_proposal: HarnessSettlement) => {});
    const failure = { code: "MODEL_FAILED", message: "Model failed" };
    expect(
      await emitRecoverableFailedTurn(
        emit,
        state,
        { ...failure, continuationToken: "alias" },
        settle,
      ),
    ).toBe(state);
    await emitFailedStep(emit, state, { ...failure, sessionId: "session" }, settle);
    expect(emit).not.toHaveBeenCalled();
    expect(settle.mock.calls.map(([proposal]) => proposal.events.at(-1)?.type)).toEqual([
      "session.waiting",
      "session.failed",
    ]);
  });

  it("lets a direct harness consumer commit its terminal events immediately", async () => {
    const emit = vi.fn(async () => {});
    const after = await emitTurnEpilogue(emit, state, "task");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(after.turnId).toBe("");
    expect(after.sequence).toBe(4);
  });

  it("uses the owner's chosen turn identity in the preamble and clears the pending identity", async () => {
    const before = { ...state, turnId: "", nextTurnId: "turn_candidate" };
    const emit = vi.fn(async () => {});
    expect(activeTurnId(before)).toBe("turn_candidate");
    const after = await emitTurnPreamble(emit, {}, before);
    expect(after.turnId).toBe("turn_candidate");
    expect(after.nextTurnId).toBeUndefined();
    expect(activeTurnId(after)).toBe("turn_candidate");
  });
});
