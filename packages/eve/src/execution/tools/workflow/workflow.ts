import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  createWorkflowBodyRef,
  startCallBody,
  type StartedWorkflowBody,
  type WorkflowBodyInput,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import {
  isWorkflowToolRunControlMessage,
  type WorkflowToolRunMessage,
  type WorkflowToolRunOutcome,
} from "#execution/tools/workflow/messages.js";
import { AgentSessions } from "#execution/agent-sessions/session.js";
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

/** Owns command intake, body execution, and settlement for one workflow tool call. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const owner = createBlockingWorkflow(input);
  const inbox = openWorkflowToolRunOwnerInbox();
  if (input.entry.entryPoint !== "execute") await reportTaskStarted(input);
  const agentSessions = new AgentSessions({
    context: input.agentContext,
    from: createWorkflowBodyRef(input),
    inbox: inbox.owner.inbox,
  });
  const started = startWorkflowBody({ ...input, owner: inbox.owner }, agentSessions);
  const signal = started.control.runSignal;
  const body: ChannelReader<"body", WorkflowBodyResult> = createChannelReader(
    "body",
    awaitBodyResult(started.result),
  );
  let commandsOpen = true;
  let relayedMessages = 0;
  let bodyResult: WorkflowBodyResult | undefined;
  let cleanupDeadline: Promise<"cancel"> | undefined;
  let outcome: WorkflowToolRunOutcome | undefined;

  // End the agent sessions on every exit: a relay throws once the calling
  // session's inbox is gone, which is exactly when its agents must stop.
  try {
    while (true) {
      if (signal.aborted) {
        cleanupDeadline ??= sleep(WORKFLOW_CANCELLATION_CLEANUP_MS).then(() => "cancel");
      }
      if (
        // Wait for the body to produce its final outcome.
        bodyResult !== undefined &&
        // Its reports, replies, and `agent.started` announcements must be relayed before settlement.
        relayedMessages >= bodyResult.messageCount + agentSessions.announcements &&
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
        const command = read.next.value;
        if (isWorkflowToolRunControlMessage(command)) started.control.apply(command);
        continue;
      }
      if (read.channel === "body") {
        bodyResult = read.next.value;
        continue;
      }
      const message = read.next.value;
      if (message.kind === "outcome") continue;
      if (isRelayedBeforeOutcome(message)) relayedMessages += 1;
      await owner.handleMessage(message);
    }
  } finally {
    await agentSessions.end();
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
 * Tells the session a task's run can take commands. Sending suspends the run,
 * which registers its control hook before the session hears of it, so a cancel
 * the session held until now reaches the body.
 */
async function reportTaskStarted(input: WorkflowToolRunInput): Promise<void> {
  await resumeHookStep(
    input.owner.inbox,
    { from: createWorkflowBodyRef(input), kind: "started" },
    { ifPresent: true },
  );
}

/** Starts the body the run's entry point names. */
function startWorkflowBody(
  input: WorkflowBodyInput,
  agentSessions: AgentSessions,
): StartedWorkflowBody {
  switch (input.entry.entryPoint) {
    case "execute":
    case "task":
      return startCallBody(input, agentSessions);
    case "serve":
      return startServeBody(input, agentSessions);
  }
}

/** Messages the run must relay before its outcome, so none arrives after its calls settle. */
function isRelayedBeforeOutcome(message: WorkflowToolRunMessage): boolean {
  return message.kind === "report" || message.kind === "reply" || message.kind === "agent-started";
}

async function* awaitBodyResult(
  result: Promise<WorkflowBodyResult>,
): AsyncGenerator<WorkflowBodyResult> {
  yield await result;
}
