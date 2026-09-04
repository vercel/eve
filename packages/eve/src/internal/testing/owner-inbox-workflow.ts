import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { createOwnerInbox } from "#execution/inbox/owner.js";
import { publishOwnerStep } from "#execution/inbox/readiness.js";
import { sendInboxStep } from "#execution/inbox/send.js";
import type { InboxAddress, InboxEnvelope } from "#execution/inbox/types.js";
import { acknowledgeWorkflowTools, startWorkflowToolRun } from "#execution/workflow-tool/start.js";
import type { WorkflowToolRunRequestMessage } from "#execution/workflow-tool/messages.js";

export async function ownerInboxTestWorkflow(input: {
  readonly token: string;
  readonly toolWorkflowId?: string;
  readonly count?: number;
}): Promise<InboxEnvelope[]> {
  "use workflow";
  const inbox = createOwnerInbox({ token: input.token });
  try {
    const claim = await inbox.claim();
    await publishOwnerStep(
      claim.kind === "owned" ? inbox.address : { token: input.token, ownerRunId: claim.runId },
    );
    if (claim.kind === "conflict") return [];
    if (input.toolWorkflowId !== undefined)
      await startTestToolStep(inbox.address, input.toolWorkflowId);
    const received: InboxEnvelope[] = [];
    while (true) {
      const event = await inbox.next();
      received.push(event);
      if (event.kind === "tool.request") {
        const request = event.payload as WorkflowToolRunRequestMessage;
        if (request.replyTo.kind !== "inbox")
          throw new Error("Expected workflow question reply target.");
        await sendInboxStep(request.replyTo.address, {
          eventId: `${request.replyTo.requestId}:answer`,
          kind: "tool.response",
          payload: { optionId: "approve" },
          requestId: request.replyTo.requestId,
        });
      }
      if (event.kind === "tool.outcome" || received.length === input.count) return received;
    }
  } finally {
    await inbox.dispose();
  }
}

async function startTestToolStep(owner: InboxAddress, workflowId: string): Promise<void> {
  "use step";
  const run = await startWorkflowToolRun({
    callId: "deploy",
    input: { service: "api" },
    owner,
    session: {
      auth: { current: null, initiator: null },
      id: getWorkflowMetadata().workflowRunId,
      turn: { id: "turn", sequence: 0 },
    },
    stepIndex: 0,
    toolName: "deploy",
    workflowId,
  });
  await acknowledgeWorkflowTools({ runs: [run] });
}
