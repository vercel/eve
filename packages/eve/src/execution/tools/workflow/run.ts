import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
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
import type { RunHost } from "#execution/run-host.js";
import { startServeBody } from "#execution/tools/workflow/serve.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

const SERVE_CLEANUP_EXPIRED =
  "The task was cancelled and its serve body didn't return to receive() within 30 seconds.";

export async function runWorkflowToolRun(
  input: WorkflowToolRunInput,
  host: RunHost,
): Promise<void> {
  const run = { ...input, runId: host.runId() };
  const owner = createBlockingWorkflow(input, host);
  const inbox = openWorkflowToolRunOwnerInbox();
  const isTask = input.entry.entryPoint !== "execute";
  if (isTask && !(await owner.register())) {
    await reportTaskStarted(run, host);
    return;
  }
  const started = startWorkflowBody({ ...run, host, owner: inbox.owner });
  const reported = isTask ? reportTaskStarted(run, host) : undefined;
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

  let closed = false;
  try {
    await reported;
    while (true) {
      if (started.control.unwinding) {
        cleanupDeadline ??= host
          .sleep(WORKFLOW_CANCELLATION_CLEANUP_MS)
          .then(() => "cancel" as const);
      }
      if (
        bodyOutcome !== undefined &&
        relayedMessages >= inbox.owner.sent &&
        owner.commands.landed.length === 0 &&
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
        if (!started.control.unwinding) {
          cleanupDeadline = undefined;
          continue;
        }
        if (!signal.aborted) started.control.apply({ kind: "end", reason: SERVE_CLEANUP_EXPIRED });
        break;
      }
      if (read.next.done) {
        if (read.channel === "control") {
          commandsOpen = false;
          continue;
        }
        outcome = { status: "failed", error: "Workflow body ended without an outcome." };
        break;
      }
      if (read.channel === "control") {
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
      if (messages.some(isAnsweredOnControlHook)) await owner.register();
      await owner.relay(messages);
    }
    if (signal.aborted) {
      outcome = {
        status: "cancelled",
        reason:
          signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
      };
    }
    closed = true;
    const closing = started.close();
    if (outcome !== undefined) {
      const usage = started.usage.total();
      const [closeResult, deliverResult] = await Promise.allSettled([
        closing,
        owner.handleMessage({
          from: createWorkflowBodyRef(run),
          kind: "outcome",
          result: outcome,
          ...(usage !== undefined && { usage }),
        }),
      ]);
      if (deliverResult.status === "rejected") throw deliverResult.reason;
      if (closeResult.status === "rejected") throw closeResult.reason;
    } else {
      await closing;
    }
  } finally {
    if (!closed) await started.close();
  }
}

async function reportTaskStarted(
  input: WorkflowToolRunInput & { readonly runId: string },
  host: RunHost,
): Promise<void> {
  await host.resumeHook(
    input.owner.inbox,
    { from: createWorkflowBodyRef(input), kind: "started" },
    { ifPresent: true },
  );
}

function applyControlMessage(started: StartedWorkflowBody, message: unknown): void {
  if (!isWorkflowToolRunControlMessage(message)) return;
  if (isWorkflowToolRunAskDecision(message)) {
    started.asks.settle(message);
    return;
  }
  started.control.apply(message);
}

function isAnsweredOnControlHook(message: WorkflowToolRunMessage): boolean {
  return (
    message.kind === "withdraw" || (message.kind === "request" && message.request.kind === "ask")
  );
}

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
