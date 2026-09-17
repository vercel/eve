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
import {
  openWorkflowToolRunOwnerInbox,
  type WorkflowToolRunOwnerInbox,
} from "#execution/tools/workflow/owner.js";
import { createBackgroundWorkflowOwner } from "#execution/tools/workflow/background-owner.js";
import { createWaitingWorkflowOwner } from "#execution/tools/workflow/waiting-owner.js";
import type {
  BackgroundWorkflowToolRunInput,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";

/** Owns admission, command intake, body execution, and settlement for either lifetime. */
export async function runWorkflowToolInvocation(
  input: WorkflowToolRunInput | BackgroundWorkflowToolRunInput,
): Promise<void> {
  const owner =
    "workflow" in input
      ? await createBackgroundWorkflowOwner(input)
      : createWaitingWorkflowOwner(input);
  if (owner === undefined) return;
  const definition =
    "workflow" in input
      ? { ...input.workflow, execution: "background" as const }
      : { ...input, execution: input.execution ?? "blocking" };
  const { signal } = owner;
  let admitted = owner.kind === "turn";
  let commandsOpen = true;
  let body:
    | {
        readonly inbox: WorkflowToolRunOwnerInbox;
        readonly reader: ChannelReader<"body", WorkflowBodyResult>;
      }
    | undefined;
  let consumedReports = 0;
  let bodyResult: WorkflowBodyResult | undefined;
  let cleanupDeadline: Promise<"cancel"> | undefined;
  let outcome: WorkflowToolRunOutcome | undefined;

  while (true) {
    if (admitted && signal.aborted) {
      if (body === undefined) break;
      cleanupDeadline ??= sleep(WORKFLOW_CANCELLATION_CLEANUP_MS).then(() => "cancel");
    }
    // Hook persistence does not mean the owner has consumed every report yet.
    if (
      bodyResult !== undefined &&
      consumedReports >= bodyResult.reportCount &&
      owner.commands.landed.length === 0 &&
      owner.commands.failure === undefined
    ) {
      outcome = bodyResult.outcome;
      break;
    }
    let read;
    try {
      if (admitted && body === undefined) {
        const inbox = openWorkflowToolRunOwnerInbox();
        body = {
          inbox,
          reader: createChannelReader(
            "body",
            awaitBodyResult(executeWorkflowBody({ ...definition, owner: inbox.owner }, signal)),
          ),
        };
      }
      read = await raceChannelReads(
        [
          ...(commandsOpen ? [owner.commands] : []),
          ...(body === undefined ? [] : [body.inbox.reader]),
          ...(body === undefined || bodyResult !== undefined ? [] : [body.reader]),
        ],
        cleanupDeadline,
      );
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
      if (admitted && signal.aborted) break;
      return;
    }
    if (read.channel === "control") {
      if (owner.kind !== "turn")
        throw new Error("Session-owned invocation received a turn command.");
      owner.handleCommand(read.next.value);
      continue;
    }
    if (read.channel === "commands") {
      if (owner.kind !== "session")
        throw new Error("Turn-owned invocation received a task command.");
      const payload = read.next.value;
      if (
        admitted &&
        payload.kind === "task-command" &&
        (payload.command.kind === "ready" || payload.command.kind === "reject-dispatch")
      )
        continue;
      const action = await owner.handleCommand(payload);
      if (action === "stop") return;
      if (action === "start") admitted = true;
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
      from: createWorkflowBodyRef(definition),
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
