import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  createWorkflowBodyRef,
  startCallBody,
  type StartedWorkflowBody,
  type WorkflowBodyInput,
} from "#execution/tools/workflow/body.js";
import {
  isWorkflowToolRunAskDecision,
  isWorkflowToolRunControlMessage,
  type WorkflowToolRunMessage,
  type WorkflowToolRunOutcome,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  raceChannelReads,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";
import { createBlockingWorkflow } from "#execution/tools/workflow/workflow-owner-blocking.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { startServeBody } from "#execution/tools/workflow/serve.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

const SERVE_CLEANUP_EXPIRED =
  "The task was cancelled and its serve body didn't return to receive() within 30 seconds.";

/** Owns command intake, body execution, and settlement for one workflow tool call. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const owner = createBlockingWorkflow(input);
  const inbox = openWorkflowToolRunOwnerInbox();
  const isTask = input.entry.entryPoint !== "execute";
  // A task's session holds its commands until the run reports started, and a
  // command that reaches the control hook before it is registered is lost.
  if (isTask && !(await owner.register())) {
    // A duplicate start of the task: the run holding the hook does its work.
    // Started still releases the commands the session holds to that hook.
    await reportTaskStarted(input);
    return;
  }
  const started = startWorkflowBody({ ...input, owner: inbox.owner });
  // Reported alongside the body's first step instead of before it.
  const reported = isTask ? reportTaskStarted(input) : undefined;
  const signal = started.control.runSignal;
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
    // A task's session must hear started before anything else.
    await reported;
    while (true) {
      if (started.control.unwinding) {
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
      if (read === "cancel") {
        // A serve body can return to receive() before its deadline.
        if (!started.control.unwinding) {
          cleanupDeadline = undefined;
          continue;
        }
        // One that doesn't ends with its task.
        if (!signal.aborted) started.control.apply({ kind: "end", reason: SERVE_CLEANUP_EXPIRED });
        break;
      }
      if (read.next.done) {
        if (read.channel === "control") {
          commandsOpen = false;
          continue;
        }
        // The inbox never ends, so only the body can.
        outcome = { status: "failed", error: "Workflow body ended without an outcome." };
        break;
      }
      if (read.channel === "control") {
        // The deadline counts from the cancel the body is unwinding now.
        if (!started.control.unwinding) cleanupDeadline = undefined;
        applyControlMessage(started, read.next.value);
        continue;
      }
      if (read.channel === "body") {
        bodyOutcome = read.next.value;
        continue;
      }
      const messages = read.next.value;
      relayedMessages += messages.length;
      // An execute run's generated token can't be held by another run.
      if (messages.some(isAnsweredOnControlHook)) await owner.register();
      await owner.relay(messages);
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
    const usage = started.usage.total();
    await owner.handleMessage({
      from: createWorkflowBodyRef(input),
      kind: "outcome",
      result: outcome,
      ...(usage !== undefined && { usage }),
    });
  }
}

/**
 * Tells the session a task's run can take commands. Call it only once a run
 * holds the control hook, so a cancel the session held until now reaches it.
 */
async function reportTaskStarted(input: WorkflowToolRunInput): Promise<void> {
  await resumeHookStep(
    input.owner.inbox,
    { from: createWorkflowBodyRef(input), kind: "started" },
    { ifPresent: true },
  );
}

/**
 * Applies one message from the run's control hook. Decisions on questions and
 * commands share the hook, so the body sees them in the order the session
 * made them.
 */
function applyControlMessage(started: StartedWorkflowBody, message: unknown): void {
  if (!isWorkflowToolRunControlMessage(message)) return;
  if (isWorkflowToolRunAskDecision(message)) {
    started.asks.settle(message);
    return;
  }
  started.control.apply(message);
}

/**
 * The session may answer a question, or its withdrawal, on the control hook
 * as soon as it reads it, so the hook must be registered before the relay.
 * Waiting for that only when needed keeps the run's first steps inline.
 */
function isAnsweredOnControlHook(message: WorkflowToolRunMessage): boolean {
  return (
    message.kind === "withdraw" || (message.kind === "request" && message.request.kind === "ask")
  );
}

/** Starts the body the run's entry point names. */
function startWorkflowBody(input: WorkflowBodyInput): StartedWorkflowBody {
  switch (input.entry.entryPoint) {
    case "execute":
    case "task":
      return startCallBody(input);
    case "serve":
      return startServeBody(input);
  }
}

async function* awaitBodyOutcome(
  outcome: Promise<WorkflowToolRunOutcome>,
): AsyncGenerator<WorkflowToolRunOutcome> {
  yield await outcome;
}
