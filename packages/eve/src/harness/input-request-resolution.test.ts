import { describe, expect, it } from "vitest";

import {
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
  unavailableToolMessage,
} from "#harness/input-request-resolution.js";

describe("resolveApprovalOutcome", () => {
  it.each(["cancel", "deny"])("keeps the note sent with a %s as the denial reason", (optionId) => {
    expect(
      resolveApprovalOutcome({
        optionId,
        requestId: "req-1",
        text: "  only the three-pack, with a $50 minimum ",
      }),
    ).toEqual({
      approved: false,
      reason: `${TOOL_EXECUTION_DENIED_MESSAGE} The person who denied it wrote: "only the three-pack, with a $50 minimum"`,
      status: "denied",
    });
  });

  it.each([undefined, "", "   "])("uses the bare denial when the note is %j", (text) => {
    expect(resolveApprovalOutcome({ optionId: "cancel", requestId: "req-1", text })).toEqual({
      approved: false,
      reason: TOOL_EXECUTION_DENIED_MESSAGE,
      status: "denied",
    });
  });
});

describe("unavailableToolMessage", () => {
  it("points at eve__search only for an agent that has it", () => {
    expect(unavailableToolMessage("deploy", true)).toBe(
      'The tool "deploy" is no longer available, so the call didn\'t run. If the task still needs it, find an available tool with eve__search and make a new call.',
    );
    expect(unavailableToolMessage("deploy", false)).toBe(
      'The tool "deploy" is no longer available, so the call didn\'t run. If the task still needs it, make a new call with an available tool.',
    );
  });
});
