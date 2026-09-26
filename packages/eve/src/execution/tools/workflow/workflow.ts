import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  createWorkflowBodyRef,
  executeWorkflowBody,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunOutcome } from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  raceChannelReads,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";
import { createBlockingWorkflow } from "#execution/tools/workflow/workflow-owner-blocking.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

/** Owns command intake, body execution, and settlement for one workflow tool call. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const owner = createBlockingWorkflow(input);
  const { signal } = owner;
  const inbox = openWorkflowToolRunOwnerInbox();
  const body: ChannelReader<"body", WorkflowBodyResult> = createChannelReader(
    "body",
    awaitBodyResult(
      executeWorkflowBody(
        { ...input, owner: inbox.owner },
        { abortSignal: signal, interruptSignal: owner.interruptSignal },
      ),
    ),
  );
  let commandsOpen = true;
  let consumedReports = 0;
  let bodyResult: WorkflowBodyResult | undefined;
  let cleanupDeadline: Promise<"cancel"> | undefined;
  let outcome: WorkflowToolRunOutcome | undefined;

  while (true) {
    if (signal.aborted) {
      cleanupDeadline ??= sleep(WORKFLOW_CANCELLATION_CLEANUP_MS).then(() => "cancel");
    }
    if (
      // Wait for the body to produce its final outcome.
      bodyResult !== undefined &&
      // Persisted reports must also finish delivery before settlement.
      consumedReports >= bodyResult.reportCount &&
      // Handle buffered commands, especially cancellation, before publishing the outcome.
      owner.commands.landed.length === 0 &&
      // Propagate a command-read failure instead of hiding it behind completion.
      owner.commands.failure === undefined
    ) {
      outcome = bodyResult.outcome;
      break;
    }
    let read;
    try {
      const readers: Array<
        typeof owner.commands | typeof inbox.reader | ChannelReader<"body", WorkflowBodyResult>
      > = [];
      if (commandsOpen) readers.push(owner.commands);
      readers.push(inbox.reader);
      if (bodyResult === undefined) readers.push(body);
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
      owner.handleCommand(read.next.value);
      continue;
    }
    if (read.channel === "body") {
      bodyResult = read.next.value;
      continue;
    }
    if (read.next.value.kind === "outcome") continue;
    if (read.next.value.kind === "report") consumedReports += 1;
    await owner.handleMessage(read.next.value);
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

async function* awaitBodyResult(
  result: Promise<WorkflowBodyResult>,
): AsyncGenerator<WorkflowBodyResult> {
  yield await result;
}
