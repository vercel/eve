import { describe, expect, it } from "vitest";

import {
  PENDING_APPROVALS_LABEL,
  renderPendingApprovalsInstruction,
  renderPendingApprovalsSnippet,
} from "#harness/hitl/approval-prompt.js";
import type { ApprovalAsk } from "#harness/session-machine/state.js";

describe("renderPendingApprovalsSnippet", () => {
  it("projects approval identity without exposing tool input", () => {
    const content = renderPendingApprovalsSnippet([
      request("approval-1", "bash", { secret: "do-not-project" }),
    ]);

    expect(content).toBe(
      [
        PENDING_APPROVALS_LABEL,
        "The following tool calls are awaiting approval and have not executed:",
        '{"requestId":"approval-1","toolName":"bash"}',
      ].join("\n"),
    );
    expect(content).not.toContain("do-not-project");
  });

  it("renders the same redacted identity as trusted runtime guidance", () => {
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
    expect(renderPendingApprovalsSnippet([])).toBeUndefined();
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
