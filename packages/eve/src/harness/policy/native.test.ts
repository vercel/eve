import { describe, expect, it } from "vitest";

import { nativeNext } from "./native.js";
import type { ModelStep, PolicyTurn } from "./policy.js";

function after(lastStep: Partial<ModelStep>, turn: Partial<PolicyTurn> = {}) {
  return nativeNext({
    turn: {
      continuations: 0,
      id: "turn-1",
      lastStep: { endsTurn: false, madeCalls: false, text: "Here is the report.", ...lastStep },
      unread: false,
      ...turn,
    },
  });
}

describe("nativeNext", () => {
  it("settles a prose answer with its text", () => {
    expect(after({})).toEqual({ settle: { output: "Here is the report." } });
  });

  it("calls the model for unread results unless the calls end the turn, which drops narration", () => {
    expect(after({}, { unread: true })).toEqual({ model: {} });
    expect(after({ endsTurn: true }, { unread: true })).toEqual({ settle: { output: null } });
  });

  it("settles a delivered structured value", () => {
    expect(after({ output: { sources: ["Smith v. Jones"] } }, { unread: true })).toEqual({
      settle: { output: { sources: ["Smith v. Jones"] } },
    });
  });
});
