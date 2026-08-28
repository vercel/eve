import { describe, expect, it } from "vitest";

import { readEvalExecutionIdentity, withEvalExecutionIdentity } from "#protocol/eval-identity.js";

describe("eval execution identity", () => {
  it("reads an identity only when both reserved headers are present", () => {
    expect(
      readEvalExecutionIdentity(
        new Headers({ "x-eve-eval-id": "case-1", "x-eve-eval-run-id": "run-1" }),
      ),
    ).toEqual({ evalId: "case-1", runId: "run-1" });
    expect(readEvalExecutionIdentity(new Headers({ "x-eve-eval-id": "case-1" }))).toBeUndefined();
  });

  it("keeps framework identity authoritative across header casing", () => {
    expect(
      withEvalExecutionIdentity(
        {
          "X-Eve-Eval-Id": "forged-case",
          "x-EVE-eval-RUN-id": "forged-run",
          "x-user-header": "retained",
        },
        { evalId: "case-1", runId: "run-1" },
      ),
    ).toEqual({
      "x-eve-eval-id": "case-1",
      "x-eve-eval-run-id": "run-1",
      "x-user-header": "retained",
    });
  });
});
