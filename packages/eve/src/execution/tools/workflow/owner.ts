import { createHook } from "#compiled/@workflow/core/index.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunRequestMessage,
  WorkflowToolAuthorizationRequest,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

/**
 * The run's inbox as its body sees it. Everything the body sends its session,
 * except the outcome, goes through the run, which relays each message before
 * the outcome.
 */
export interface WorkflowToolRunInbox {
  /** Messages that reached the run's inbox so far. */
  readonly sent: number;
  send(message: Exclude<WorkflowToolRunMessage, { readonly kind: "outcome" }>): Promise<void>;
}

export interface WorkflowToolRunOwnerInbox {
  readonly owner: WorkflowToolRunInbox;
  readonly reader: ChannelReader<"workflow", WorkflowToolRunMessage>;
}

/** Receives body messages before routing them to the waiting turn. */
export function openWorkflowToolRunOwnerInbox(): WorkflowToolRunOwnerInbox {
  const hook = createHook<WorkflowToolRunMessage>();
  let sent = 0;
  return {
    owner: {
      get sent() {
        return sent;
      },
      async send(message) {
        await resumeHookStep(hook.token, message);
        sent += 1;
      },
    },
    reader: createChannelReader("workflow", hook),
  };
}

/** Acknowledge only step-owned events, after delivery or deliberate discard. */
export async function deliverWorkflowAuthorization(
  message: WorkflowToolRunRequestMessage & { readonly request: WorkflowToolAuthorizationRequest },
  deliver: () => Promise<void>,
): Promise<void> {
  await deliver();
  // Agent events reuse their invocation reply channel; it is not an event acknowledgement.
  if (message.request.event.childSessionId === message.from.runId)
    await resumeHookStep(message.replyTo, null, { ifPresent: true });
}
