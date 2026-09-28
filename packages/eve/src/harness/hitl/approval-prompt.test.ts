import { describe, expect, it } from "vitest";

import { renderPendingApprovalsInstruction } from "#harness/hitl/approval-prompt.js";
import type { InputRequest } from "#shared/input.js";

describe("renderPendingApprovalsInstruction", () => {
  it("names each pending approval as trusted runtime state without exposing tool input", () => {
    const content = renderPendingApprovalsInstruction([
      request("tool-approval", "approval-1", "bash", { secret: "do-not-project" }),
      request("question", "question-1", "ask_question", { prompt: "Continue?" }),
    ]);

    expect(content).toContain("Trusted eve runtime state");
    expect(content).toContain('{"requestId":"approval-1","toolName":"bash"}');
    expect(content).toContain("latest user message");
    expect(content).toContain("supersede");
    expect(content).not.toContain("do-not-project");
    expect(content).not.toContain("question-1");
  });

  it("omits the notice when no approval is pending", () => {
    expect(
      renderPendingApprovalsInstruction([
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
