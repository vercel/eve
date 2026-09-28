import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createWorkflowBodyRef, startWorkflowBody } from "#execution/tools/workflow/body.js";
import { WorkflowToolRunAsks } from "#execution/tools/workflow/ask.js";
import {
  isWorkflowToolRunAskDecision,
  isWorkflowToolRunControlMessage,
  type WorkflowToolRunOutcome,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  raceChannelReads,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";
import {
  createBlockingWorkflow,
  type BlockingWorkflowOwner,
} from "#execution/tools/workflow/workflow-owner-blocking.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

/** Owns command intake, body execution, and settlement for one workflow tool call. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const asks = new WorkflowToolRunAsks(createWorkflowBodyRef(input).runId);
  const owner = createBlockingWorkflow(input, asks);
  const { signal } = owner;
  const inbox = openWorkflowToolRunOwnerInbox();
  const started = startWorkflowBody(
    { ...input, owner: inbox.owner },
    { abortSignal: signal, interruptSignal: owner.interruptSignal },
    asks,
  );
  const body: ChannelReader<"body", WorkflowToolRunOutcome> = createChannelReader(
    "body",
    awaitBodyOutcome(started.outcome),
  );
  let commandsOpen = true;
  let relayedMessages = 0;
  let bodyOutcome: WorkflowToolRunOutcome | undefined;
  let cleanupDeadline: Promise<"cancel"> | undefined;
  let outcome: WorkflowToolRunOutcome | undefined;

  // Close the body on every exit: a relay throws once the calling session's
  // inbox is gone, which is exactly when what the body opened must stop.
  try {
    while (true) {
      if (signal.aborted) {
        cleanupDeadline ??= sleep(WORKFLOW_CANCELLATION_CLEANUP_MS).then(() => "cancel");
      }
      if (
        // Wait for the body to produce its final outcome.
        bodyOutcome !== undefined &&
        // Everything the body sent must be relayed before settlement.
        relayedMessages >= inbox.owner.sent &&
        // Handle buffered commands, especially cancellation, before publishing the outcome.
        owner.commands.landed.length === 0 &&
        // Propagate a command-read failure instead of hiding it behind completion.
        owner.commands.failure === undefined
      ) {
        outcome = bodyOutcome;
        break;
      }
      let read;
      try {
        const readers: Array<
          | typeof owner.commands
          | typeof inbox.reader
          | ChannelReader<"body", WorkflowToolRunOutcome>
        > = [];
        if (commandsOpen) readers.push(owner.commands);
        readers.push(inbox.reader);
        if (bodyOutcome === undefined) readers.push(body);
        read = await raceChannelReads(readers, cleanupDeadline);
      } catch (error) {
        if (owner.commands.failure !== undefined) throw error;
        outcome = { status: "failed", error: normalizeSerializableError(error) };
        break;
      }
      if (read === "cancel") break;
      if (read.next.done) {
        if (read.channel === "control") {
          commandsOpen = false;
          continue;
        }
        if (read.channel === "body") {
          outcome = { status: "failed", error: "Workflow body ended without an outcome." };
          break;
        }
        if (signal.aborted) break;
        return;
      }
      if (read.channel === "control") {
        applyControlMessage(owner, asks, read.next.value);
        continue;
      }
      if (read.channel === "body") {
        bodyOutcome = read.next.value;
        continue;
      }
      const message = read.next.value;
      if (message.kind === "outcome") continue;
      relayedMessages += 1;
      await owner.handleMessage(message);
    }
  } finally {
    await started.close();
  }
  // Cleanup cannot undo cancellation, even when the body returns success.
  if (signal.aborted) {
    outcome = {
      status: "cancelled",
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
    };
  }
  if (outcome !== undefined) {
    await owner.handleMessage({
      from: createWorkflowBodyRef(input),
      kind: "outcome",
      result: outcome,
    });
  }
}

/**
 * Applies one message from the run's control hook. Decisions on questions and
 * commands share the hook, so the body sees them in the order the session
 * made them.
 */
function applyControlMessage(
  owner: BlockingWorkflowOwner,
  asks: WorkflowToolRunAsks,
  message: unknown,
): void {
  if (!isWorkflowToolRunControlMessage(message)) return;
  if (isWorkflowToolRunAskDecision(message)) {
    asks.settle(message);
    return;
  }
  owner.handleCommand(message);
}

async function* awaitBodyOutcome(
  outcome: Promise<WorkflowToolRunOutcome>,
): AsyncGenerator<WorkflowToolRunOutcome> {
  yield await outcome;
}
