import { describe, expect, it } from "vitest";

import { chooseNext, type ModelStepOutcome } from "./next.js";

const answered: ModelStepOutcome = {
  delivered: false,
  endsOnToolResults: false,
  endsTurn: false,
  providerOutcomeEndsResponse: false,
  queuedInput: false,
  text: "Here is the report.",
  workingTaskIds: [],
};

describe("chooseNext", () => {
  it("settles a prose answer with its text", () => {
    expect(chooseNext(answered)).toEqual({ kind: "settle", output: "Here is the report." });
  });

  it("continues on unread tool results unless the calls end the turn, which drops narration", () => {
    expect(chooseNext({ ...answered, endsOnToolResults: true })).toEqual({
      kind: "continue",
      reason: "tool-results",
    });
    expect(chooseNext({ ...answered, endsOnToolResults: true, endsTurn: true })).toEqual({
      kind: "settle",
      output: null,
    });
  });

  it("continues before waiting on tasks, and waits on tasks before settling", () => {
    const working = { ...answered, workingTaskIds: ["task-1"] };
    expect(chooseNext({ ...working, queuedInput: true })).toEqual({
      kind: "continue",
      reason: "queued-input",
    });
    expect(chooseNext(working)).toEqual({ kind: "wait", taskIds: ["task-1"] });
  });

  it("settles a delivered structured value even with input queued", () => {
    expect(chooseNext({ ...answered, delivered: true, queuedInput: true })).toMatchObject({
      kind: "settle",
    });
  });
});
