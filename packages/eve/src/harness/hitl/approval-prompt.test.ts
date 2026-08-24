import { describe, expect, it } from "vitest";

import {
  PENDING_APPROVALS_LABEL,
  renderPendingApprovalsSnippet,
} from "#harness/hitl/approval-prompt.js";
import type { InputRequest } from "#shared/input.js";

describe("renderPendingApprovalsSnippet", () => {
  it("projects approval identity without exposing tool input", () => {
    const content = renderPendingApprovalsSnippet([
      request("tool-approval", "approval-1", "bash", { secret: "do-not-project" }),
      request("question", "question-1", "ask_question", { prompt: "Continue?" }),
    ]);

    expect(content).toBe(
      [
        PENDING_APPROVALS_LABEL,
        "The following tool calls are awaiting approval and have not executed:",
        '{"requestId":"approval-1","toolName":"bash"}',
      ].join("\n"),
    );
    expect(content).not.toContain("do-not-project");
    expect(content).not.toContain("question-1");
  });

  it("omits the notice when no approval is pending", () => {
    expect(
      renderPendingApprovalsSnippet([
        request("question", "question-1", "ask_question", { prompt: "Continue?" }),
      ]),
    ).toBeUndefined();
  });
});

function request(
  kind: InputRequest["kind"],
  requestId: string,
  toolName: string,
  input: InputRequest["action"]["input"],
): InputRequest {
  return {
    action: { callId: `${requestId}-call`, input, kind: "tool-call", toolName },
    kind,
    prompt: requestId,
    requestId,
  };
}
