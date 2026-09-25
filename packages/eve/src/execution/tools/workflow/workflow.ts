import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  createWorkflowBodyRef,
  executeWorkflowBody,
  firstGenerationCall,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import {
  createGenerations,
  type GenerationCall,
  type GenerationEvent,
  type Generations,
} from "#execution/tools/workflow/generations.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunGenerationMessage,
  WorkflowToolRunOutcome,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  raceChannelReads,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import {
  openWorkflowToolRunOwnerInbox,
  type WorkflowToolRunOwnerInbox,
} from "#execution/tools/workflow/owner.js";
import { createBlockingWorkflow } from "#execution/tools/workflow/workflow-owner-blocking.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import {
  logIgnoredWorkflowResultStep,
  logUndeliveredGenerationStep,
  logUndeliveredWorkflowOutcomeStep,
} from "#execution/tools/workflow/undelivered-outcome-step.js";

/**
 * Owns command intake, body execution, and settlement for one workflow tool
 * call. A resumable run stays alive between generations: its command hook
 * carries sends as well as cancels, it reports each generation, and it ends
 * with the task. The run returns the outcome it reported (a resumable run,
 * its last reply), so the owner's deadline for a call with a time limit can
 * read it once if the report never arrived, including a report whose
 * delivery failed for good; a duplicate start returns nothing.
 */
export async function workflowToolRunWorkflow(
  input: WorkflowToolRunInput,
): Promise<WorkflowToolRunOutcomeMessage | undefined> {
  "use workflow";

  const owner = createBlockingWorkflow(input);
  if (!(await owner.claim())) return undefined;
  const definition = input;
  const { signal } = owner;
  const generations: Generations | undefined =
    definition.resumable === true ? createGenerations(firstGenerationCall(definition)) : undefined;
  const wakes =
    generations === undefined ? undefined : createChannelReader("generation", generations.wakes);
  const { input: _input, ...base } = createWorkflowBodyRef(definition);
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
  let lastReply: Extract<GenerationEvent, { readonly kind: "reply" }> | undefined;
  // A lifecycle message that cannot be delivered is logged, not thrown: failing
  // the run would lose the task's end too, which settles whatever the owner
  // still thinks is working.
  const deliverGeneration = async (message: WorkflowToolRunGenerationMessage): Promise<void> => {
    try {
      await owner.handleMessage(message);
    } catch (error) {
      await logUndeliveredGenerationStep({ error: normalizeSerializableError(error), message });
    }
  };
  const relay = async (event: GenerationEvent): Promise<void> => {
    if (event.kind === "reply") lastReply = event;
    await deliverGeneration(generationMessage(base, event));
  };
  // A reply waits until the progress reports the body sent before it reach the owner.
  const relayGenerations = async (): Promise<void> => {
    let event = generations?.next(consumedReports);
    while (event !== undefined) {
      await relay(event);
      event = generations?.next(consumedReports);
    }
  };

  while (true) {
    await relayGenerations();
    if (signal.aborted) {
      if (body === undefined) break;
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
      if (body === undefined) {
        const inbox = openWorkflowToolRunOwnerInbox();
        body = {
          inbox,
          reader: createChannelReader(
            "body",
            awaitBodyResult(
              executeWorkflowBody({ ...definition, owner: inbox.owner }, signal, generations),
            ),
          ),
        };
      }
      const readers: Array<
        | typeof owner.commands
        | WorkflowToolRunOwnerInbox["reader"]
        | ChannelReader<"body", WorkflowBodyResult>
        | ChannelReader<"generation", void>
      > = [];
      if (commandsOpen) readers.push(owner.commands);
      if (wakes !== undefined) readers.push(wakes);
      if (body !== undefined) {
        readers.push(body.inbox.reader);
        if (bodyResult === undefined) readers.push(body.reader);
      }
      read = await raceChannelReads(readers, cleanupDeadline);
    } catch (error) {
      if (owner.commands.failure !== undefined) throw error;
      outcome = { status: "failed", error: normalizeSerializableError(error) };
      break;
    }
    if (read === "cancel") break;
    if (read.channel === "generation") continue;
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
      return undefined;
    }
    if (read.channel === "control") {
      const command = read.next.value;
      if (generations !== undefined) {
        if (command.kind === "input") {
          generations.deliver(command.seq, command.input, sendCall(command));
          continue;
        }
        if (command.end !== true) {
          generations.cancel(command.reason);
          continue;
        }
        generations.end(command.reason);
      }
      owner.handleCommand(command);
      continue;
    }
    if (read.channel === "body") {
      bodyResult = read.next.value;
      continue;
    }
    if (read.next.value.kind === "report") consumedReports += 1;
    else if (read.next.value.kind !== "request") continue;
    await owner.handleMessage(read.next.value);
  }
  // Cleanup cannot undo cancellation, even when the body returns success.
  if (signal.aborted) {
    outcome = {
      status: "cancelled",
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
    };
  }
  if (outcome === undefined) return undefined;
  const message: WorkflowToolRunOutcomeMessage = { from: base, result: outcome };
  if (generations !== undefined) return await endGenerations(message, generations);
  let delivered: boolean;
  try {
    delivered = await owner.handleMessage({ ...message, kind: "outcome" });
  } catch (error) {
    // Failing the run would turn a finished body into EXECUTION_FAILED. Only
    // a call with a time limit recovers: its deadline reads the returned
    // outcome. A call without one waits until its session ends.
    await logUndeliveredWorkflowOutcomeStep({
      error: normalizeSerializableError(error),
      message,
    });
    return message;
  }
  // The owner session had ended. A session cancels its runs as it ends, so
  // only a run that finished first is worth a warning.
  if (!delivered && outcome.status !== "cancelled") {
    await logUndeliveredWorkflowOutcomeStep({ message });
  }
  return message;

  /**
   * The body finished, which ends a resumable task: its last generation
   * settles, then the run reports the sends the body never read. A value
   * returned, or an error thrown, after a reply would be a second result, so
   * it is logged and dropped. The run returns its last reply, the result the
   * owner's deadline read settles if the owner never got it.
   */
  async function endGenerations(
    ended: WorkflowToolRunOutcomeMessage,
    state: Generations,
  ): Promise<WorkflowToolRunOutcomeMessage> {
    const finished = state.finish(ended.result);
    for (let event = state.next(Infinity); event !== undefined; event = state.next(Infinity)) {
      await relay(event);
    }
    const from = { ...base, ...generationFrom(state.call), generation: state.generation };
    await deliverGeneration({ from, kind: "ended", unread: finished.unread });
    const ignored = finished.ignored;
    if (
      ignored !== undefined &&
      (ignored.status === "failed" ||
        (ignored.status === "completed" && ignored.output !== undefined && ignored.output !== null))
    ) {
      await logIgnoredWorkflowResultStep({ from, result: ignored });
    }
    if (lastReply === undefined) return { from, result: ended.result };
    return {
      from: { ...base, ...generationFrom(lastReply.call), generation: lastReply.generation },
      result: lastReply.result,
    };
  }
}

type RunBase = Omit<WorkflowToolRunRef, "input">;

function generationMessage(
  base: RunBase,
  event: GenerationEvent,
): WorkflowToolRunGenerationMessage {
  const from = { ...base, ...generationFrom(event.call), generation: event.generation };
  return event.kind === "started"
    ? { from, kind: "started", send: event.send }
    : { from, kind: "reply", read: event.read, result: event.result };
}

function generationFrom(
  call: GenerationCall,
): Pick<WorkflowToolRunRef, "callId" | "sequence" | "stepIndex" | "turnId"> {
  return {
    callId: call.callId,
    sequence: call.turn.sequence,
    stepIndex: call.stepIndex,
    turnId: call.turn.id,
  };
}

function sendCall(
  command: Extract<WorkflowToolRunControlMessage, { readonly kind: "input" }>,
): GenerationCall {
  return { ...command.call, input: command.input };
}

async function* awaitBodyResult(
  result: Promise<WorkflowBodyResult>,
): AsyncGenerator<WorkflowBodyResult> {
  yield await result;
}
