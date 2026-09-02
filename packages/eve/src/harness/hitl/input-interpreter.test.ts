import { describe, expect, it } from "vitest";

import type { InputRequest, InputResponse } from "#shared/input.js";
import {
  approvalReducer,
  interpretInput,
  inputReducers,
  limitReducer,
  questionReducer,
  type InputGroup,
  type InputRow,
  type InputVariant,
} from "#harness/hitl/input-interpreter.js";

function row(kind: InputRequest["kind"], id = `${kind}-1`, groupId = "group-1"): InputRow {
  const variant =
    kind === "tool-approval" ? "approval" : kind === "session-limit" ? "limit" : "question";
  return {
    groupId,
    id,
    request: {
      action: { callId: `call-${id}`, input: {}, kind: "tool-call", toolName: "tool" },
      kind,
      prompt: "Prompt",
      requestId: id,
    },
    variant,
  };
}

function group(id: string, kind: InputVariant, rows: readonly InputRow[]): InputGroup {
  return { id, kind, rows };
}

function response(requestId: string, optionId: string): InputResponse {
  return { optionId, requestId };
}

function claimedGroupIds(effects: ReturnType<typeof interpretInput>): string[] {
  return effects.filter((effect) => effect.kind === "claim-group").map((effect) => effect.group.id);
}

describe("input reducers", () => {
  it.each([
    ["approve", "approved"],
    ["cancel", "cancelled"],
    ["deny", "denied"],
    ["other", "invalid"],
  ])("maps approval option %s to %s", (optionId, outcome) => {
    const approval = row("tool-approval");
    expect(
      approvalReducer.resolve(approval, {
        kind: "response",
        response: response(approval.id, optionId),
      }),
    ).toEqual({ settle: outcome });
  });

  it("settles questions with their response payload", () => {
    const question = row("question");
    expect(
      questionReducer.resolve(question, {
        kind: "response",
        response: { requestId: question.id, text: "because" },
      }),
    ).toEqual({ settle: { optionId: undefined, status: "answered", text: "because" } });
  });

  it("dismisses questions and ignores messages for approval and limit rows", () => {
    expect(questionReducer.resolve(row("question"), { kind: "message" })).toEqual({
      dismiss: "superseded",
    });
    expect(approvalReducer.resolve(row("tool-approval"), { kind: "message" })).toBe("ignore");
    expect(limitReducer.resolve(row("session-limit"), { kind: "message" })).toBe("ignore");
  });
});

describe("interpretInput", () => {
  it("dispatches each row through its reducer and returns ordered row effects", () => {
    const approval = row("tool-approval");
    const question = row("question");
    const limit = row("session-limit");

    expect(
      interpretInput({
        groups: [group("group-1", "limit", [approval, question, limit])],
        message: false,
        reducers: inputReducers,
        responses: [
          response(question.id, "red"),
          response(approval.id, "deny"),
          response(limit.id, "continue"),
        ],
      })
        .filter((effect) => effect.kind !== "claim-group")
        .map((effect) =>
          effect.kind === "settled"
            ? [effect.row.variant, effect.outcome]
            : [effect.row.variant, effect.reason],
        ),
    ).toEqual([
      ["question", { optionId: "red", status: "answered", text: undefined }],
      ["approval", "denied"],
      ["limit", "continued"],
    ]);
  });

  it("claims independently answered question groups", () => {
    const first = row("question", "question-1", "questions-1");
    const second = row("question", "question-2", "questions-2");
    const third = row("question", "question-3", "questions-3");

    const effects = interpretInput({
      groups: [
        group("questions-1", "question", [first]),
        group("questions-2", "question", [second]),
        group("questions-3", "question", [third]),
      ],
      message: false,
      reducers: inputReducers,
      responses: [response(first.id, "one"), response(third.id, "three")],
    });

    expect(claimedGroupIds(effects)).toEqual(["questions-1", "questions-3"]);
  });

  it("claims questions before the first terminal approval but preserves the approval tail", () => {
    const before = row("question", "question-before", "before");
    const approval = row("tool-approval", "approval-1", "approval");
    const after = row("question", "question-after", "after");

    const effects = interpretInput({
      groups: [
        group("before", "question", [before]),
        group("approval", "approval", [approval]),
        group("after", "question", [after]),
      ],
      message: false,
      reducers: inputReducers,
      responses: [
        response(before.id, "one"),
        response(approval.id, "approve"),
        response(after.id, "three"),
      ],
    });

    expect(claimedGroupIds(effects)).toEqual(["before", "approval"]);
  });

  it("requires every approval row in a group before claiming it", () => {
    const first = row("tool-approval", "approval-1", "approval");
    const second = row("tool-approval", "approval-2", "approval");

    const effects = interpretInput({
      groups: [group("approval", "approval", [first, second])],
      message: false,
      reducers: inputReducers,
      responses: [response(first.id, "approve")],
    });

    expect(claimedGroupIds(effects)).toEqual([]);
  });

  it("gives an open limit group precedence over other terminal groups", () => {
    const question = row("question", "question-1", "question");
    const limit = row("session-limit", "limit-1", "limit");

    const openEffects = interpretInput({
      groups: [group("question", "question", [question]), group("limit", "limit", [limit])],
      message: false,
      reducers: inputReducers,
      responses: [response(question.id, "answer")],
    });
    const closedEffects = interpretInput({
      groups: [group("question", "question", [question]), group("limit", "limit", [limit])],
      message: false,
      reducers: inputReducers,
      responses: [response(question.id, "answer"), response(limit.id, "continue")],
    });

    expect(claimedGroupIds(openEffects)).toEqual([]);
    expect(claimedGroupIds(closedEffects)).toEqual(["limit"]);
  });
});
