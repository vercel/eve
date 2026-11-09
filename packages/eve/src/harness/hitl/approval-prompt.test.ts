import { describe, expect, it } from "vitest";

import { renderPendingApprovalsInstruction } from "#harness/hitl/approval-prompt.js";
import type { ApprovalAsk } from "#harness/session-machine/state.js";

describe("renderPendingApprovalsInstruction", () => {
  it("projects approval identity as trusted runtime guidance, without tool input", () => {
    const content = renderPendingApprovalsInstruction([
      request("approval-1", "bash", { secret: "do-not-project" }),
    ]);

    expect(content).toContain("Trusted eve runtime state");
    expect(content).toContain('{"requestId":"approval-1","toolName":"bash"}');
    expect(content).toContain("latest user message");
    expect(content).toContain("supersede");
    expect(content).not.toContain("do-not-project");
  });

  it("omits the notice when no approval is pending", () => {
    expect(renderPendingApprovalsInstruction([])).toBeUndefined();
  });
});

function request(
  interactionId: string,
  toolName: string,
  input: ApprovalAsk["call"]["input"],
): ApprovalAsk {
  return {
    call: { callId: `${interactionId}-call`, input, toolName },
    interactionId,
    request: { kind: "approval", prompt: interactionId },
  };
}
