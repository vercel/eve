import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { publishOwnerStep } from "#execution/inbox/readiness.js";
import { createOwnerInbox } from "#execution/inbox/owner.js";
import { sendInboxStep } from "#execution/inbox/send.js";
import type { WorkflowToolRunOutcome } from "#execution/workflow-tool/messages.js";
import { createWorkflowBodyRef, executeWorkflowBody } from "#execution/workflow-tool/body.js";
import type { WorkflowToolRunInput } from "#execution/workflow-tool/types.js";

export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const inbox = createOwnerInbox({ token: input.hookToken });
  const controller = new AbortController();
  let readerFailure: { error: unknown } | undefined;
  const stopObserving = inbox.observe(
    (envelope) => {
      if (envelope.kind === "tool.cancel") {
        controller.abort(new Error((envelope.payload as { reason: string }).reason));
      }
    },
    (error) => {
      readerFailure = { error };
      controller.abort(error);
    },
  );
  try {
    const claim = await inbox.claim();
    await publishOwnerStep(
      claim.kind === "owned" ? inbox.address : { token: input.hookToken, ownerRunId: claim.runId },
    );
    if (claim.kind === "conflict") return;
    while (!controller.signal.aborted) {
      const event = await inbox.next();
      if (event.kind === "tool.ready") break;
    }
    const bodyInput = { ...input, execution: input.execution ?? "blocking" } as const;
    const from = createWorkflowBodyRef(bodyInput);
    let outcome: WorkflowToolRunOutcome = controller.signal.aborted
      ? {
          status: "cancelled",
          reason: String(controller.signal.reason?.message ?? controller.signal.reason),
        }
      : await executeWorkflowBody(bodyInput, controller.signal, inbox);
    if (readerFailure !== undefined) {
      outcome = { status: "failed", error: normalizeSerializableError(readerFailure.error) };
    } else if (controller.signal.aborted) {
      outcome = {
        reason: String(controller.signal.reason?.message ?? controller.signal.reason),
        status: "cancelled",
      };
    }
    const delivered = await sendInboxStep(input.owner, {
      eventId: `${from.runId}:outcome`,
      kind: "tool.outcome",
      payload: { from, result: outcome },
    });
    if (delivered !== "delivered")
      throw new Error("The workflow tool owner ended before accepting its outcome.");
  } finally {
    stopObserving();
    controller.abort(new Error("The workflow tool owner ended."));
    await inbox.dispose();
  }
}
