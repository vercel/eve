import {
  runMessageBatchBudget,
  type WorkflowToolRunMessage,
  type WorkflowToolRunRequestMessage,
  type WorkflowToolRelay,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

export interface WorkflowToolRunInbox {
  readonly sent: number;
  send(message: WorkflowToolRunBodyMessage): Promise<void>;
}

type WorkflowToolRunBodyMessage = Exclude<WorkflowToolRunMessage, { readonly kind: "outcome" }>;

export interface WorkflowToolRunOwnerInbox {
  readonly owner: WorkflowToolRunInbox;
  readonly reader: ChannelReader<"workflow", WorkflowToolRunBodyMessage[]>;
}

export function openWorkflowToolRunOwnerInbox(): WorkflowToolRunOwnerInbox {
  const queued: WorkflowToolRunBodyMessage[] = [];
  let wake: (() => void) | undefined;
  let sent = 0;
  async function* read(): AsyncGenerator<WorkflowToolRunBodyMessage[]> {
    for (;;) {
      if (queued.length > 0) {
        const admits = runMessageBatchBudget();
        const overflow = queued.findIndex((message) => !admits(message));
        yield queued.splice(0, overflow === -1 ? queued.length : overflow);
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    owner: {
      get sent() {
        return sent;
      },
      async send(message) {
        queued.push(message);
        sent += 1;
        const woken = wake;
        wake = undefined;
        woken?.();
      },
    },
    reader: createChannelReader("workflow", read()),
  };
}

export async function deliverWorkflowRelay(
  message: WorkflowToolRunRequestMessage & { readonly request: WorkflowToolRelay },
  deliver: () => Promise<void>,
): Promise<void> {
  await deliver();
  if (message.request.event.childSessionId === message.from.runId)
    await resumeHookStep(message.replyTo, null, { ifPresent: true });
}
