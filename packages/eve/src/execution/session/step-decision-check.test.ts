import { describe, expect, it } from "vitest";

import { stepDisagreement } from "#execution/session/step-decision-check.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";

const fields = { history: [], serializedContext: {}, sessionState: {} as never };
const paused = (on: "interaction" | "calls", dispatch = false) =>
  ({
    action: "paused",
    on,
    dispatch,
    callIds: [],
    taskToolCalls: [],
    attemptIds: [],
    requestIds: [],
    ...fields,
  }) as DurableStepResult;

describe("stepDisagreement", () => {
  it("agrees when a step parks between turns", () => {
    expect(stepDisagreement({ action: "parked", ...fields }, emptySessionView())).toBeUndefined();
  });

  it("names a pause the tables don't show, and labels deferred dispatch", () => {
    const view = {
      ...emptySessionView(),
      session: { latestTurnId: "turn_0", status: "open", turnCount: 1 },
      turns: {
        turn_0: {
          cause: {},
          follows: null,
          introducedAt: 0,
          startedAt: "",
          status: "running",
          turnId: "turn_0",
        },
      },
    } as never;
    expect(stepDisagreement(paused("interaction"), view)).toBe("interaction-but-session");
    expect(stepDisagreement(paused("calls", true), view)).toBe("dispatch-deferred");
    const cancel = { callId: "c_1", kind: "eve__task_cancel", taskId: "t_1" } as const;
    expect(
      stepDisagreement({ ...paused("calls"), taskToolCalls: [cancel] } as DurableStepResult, view),
    ).toBe("dispatch-deferred");
    expect(stepDisagreement({ action: "continue", ...fields }, view)).toBeUndefined();
  });
});
