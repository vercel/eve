// The programs a turn's `eve__execute` calls run, and the batches of calls they wait on. A
// program parks on calls that can't run inside its step: each batch waits in a suspended step of
// its own, which the session settles exactly as it settles a model response's calls. Once every
// call of a batch has a result, the results resume the program instead of reaching history.

import { randomBytes } from "node:crypto";

import type { ModelMessage, ToolCallPart } from "ai";

import { TOOL_EXECUTION_DENIED_MESSAGE } from "#harness/approval-outcome.js";
import { truncateNotedInput, MAX_NOTED_CALLS } from "#harness/interrupted-attempt.js";
import { toJsonValue } from "#harness/call-facts.js";
import type { JsonValue } from "#shared/json.js";
import type {
  ProgramCallResult,
  ProgramRun,
  ProgramUnfinishedCall,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "./state.js";
import { transition, type Transition } from "./commit.js";
import type { ToolResultPart } from "./suspended-steps.js";
import type { SessionView } from "./view.js";

export type { ProgramCallResult, ProgramRun, ProgramUnfinishedCall } from "./state.js";

/** The id of a program's `index`th call, the same on every resume and retry. */
export function programCallId(programCallId: string, index: number): string {
  return `${programCallId}/${String(index)}`;
}

/** Whether `callId` is one of the calls the program of `programCallId` made. */
export function isProgramCall(programCallId: string, callId: string): boolean {
  return callId.startsWith(`${programCallId}/`);
}

const CONTINUATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The program an `eve__execute` call runs, as the model step that read the call saves it. The key
 * that signs its continuations is made here, in a durable step, and never shown to the program.
 */
export function newProgram(callId: string, input: unknown, event: StepCoordinates): ProgramRun {
  const code = (input as { readonly code?: unknown } | null)?.code;
  return {
    agentCalls: 0,
    callId,
    code: typeof code === "string" ? code : "",
    counts: {},
    event,
    pending: [],
    resolutions: [],
    security: {
      maxAgeMs: CONTINUATION_MAX_AGE_MS,
      signingKey: randomBytes(32).toString("base64url"),
    },
    unfinished: [],
  };
}

export function programsOf(turn: Pick<TurnState, "programs">): readonly ProgramRun[] {
  return turn.programs ?? [];
}

export function programOf(
  turn: Pick<TurnState, "programs">,
  callId: string,
): ProgramRun | undefined {
  return programsOf(turn).find((program) => program.callId === callId);
}

/** The turn with `program` added, or replacing the one with its call id. */
export function withProgram(turn: TurnState, program: ProgramRun): TurnState {
  const others = programsOf(turn).filter(({ callId }) => callId !== program.callId);
  return { ...turn, programs: [...others, program] };
}

/** The turn without the programs in `callIds`, or the batches they wait on. */
export function withoutPrograms(turn: TurnState, callIds: ReadonlySet<string>): TurnState {
  if (callIds.size === 0 || programsOf(turn).every(({ callId }) => !callIds.has(callId)))
    return turn;
  const programs = programsOf(turn).filter(({ callId }) => !callIds.has(callId));
  const { programs: _programs, ...rest } = turn;
  return {
    ...rest,
    ...(programs.length > 0 && { programs }),
    suspended: turn.suspended.filter(
      (step) => step.program === undefined || !callIds.has(step.program.callId),
    ),
  };
}

/** The batch of calls `program` waits on, while one of them has no result. */
export function programBatch(
  turn: Pick<TurnState, "suspended">,
  program: Pick<ProgramRun, "callId">,
): SuspendedStep | undefined {
  return turn.suspended.find((step) => step.program?.callId === program.callId);
}

/**
 * The first program of the turn that can run: it hasn't started, or every call it parked on has a
 * result.
 */
export function runnableProgram(
  turn: TurnState,
  turnId: string | undefined,
): ProgramRun | undefined {
  return programsOf(turn).find(
    (program) => program.event.turnId === turnId && programBatch(turn, program) === undefined,
  );
}

/** One call a program parked on, as its batch's step holds it. */
export function batchCall(callId: string, toolName: string, input: unknown): ToolCallPart {
  return { input, toolCallId: callId, toolName, type: "tool-call" };
}

/** A batch's step: the calls a program parked on, as one response that only made those calls. */
export function batchMessages(calls: readonly ToolCallPart[]): ModelMessage[] {
  return [{ content: [...calls], role: "assistant" }];
}

/** A result as the program reads it: a tool's own output, or why the call didn't complete. */
export function programResultOf(output: ToolResultPart["output"]): ProgramCallResult {
  switch (output.type) {
    case "text":
      return { output: output.value, status: "completed" };
    case "json":
      return { output: output.value as JsonValue, status: "completed" };
    case "error-text":
      return { error: output.value, status: "failed" };
    case "error-json":
      return { error: errorText(output.value), status: "failed" };
    case "execution-denied":
      return {
        error: output.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
        outcome: "rejected",
        status: "failed",
      };
    default:
      return { output: toJsonValue(output.value), status: "completed" };
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    const { message } = value as { readonly message: unknown };
    if (typeof message === "string") return message;
  }
  return JSON.stringify(value);
}

/** The program with one more settled call counted, and noted when it didn't complete. */
export function withSettledCall(
  program: ProgramRun,
  call: { readonly toolName: string; readonly input: unknown },
  result: ProgramCallResult,
): ProgramRun {
  const outcome = result.status === "completed" ? "completed" : (result.outcome ?? "failed");
  const counts = { ...program.counts, [outcome]: (program.counts[outcome] ?? 0) + 1 };
  if (outcome === "completed" || program.unfinished.length >= MAX_NOTED_CALLS)
    return { ...program, counts };
  const unfinished: ProgramUnfinishedCall = {
    input: truncateNotedInput(JSON.stringify(call.input ?? {})),
    outcome,
    tool: call.toolName,
  };
  return { ...program, counts, unfinished: [...program.unfinished, unfinished] };
}

/**
 * Batches leave the turn, and their results go to the programs that wait on them. A call without
 * a result is answered with `stoppedResultOf` it: the batch stopped before the call settled.
 */
export function resumePrograms(
  turn: TurnState,
  batches: readonly SuspendedStep[],
  stoppedResultOf: (callId: string) => ProgramCallResult = notRun,
): TurnState {
  let next = turn;
  for (const batch of batches) {
    const program = batch.program === undefined ? undefined : programOf(next, batch.program.callId);
    if (program === undefined) continue;
    const results = new Map<string, ProgramCallResult>();
    for (const message of batch.messages) {
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type === "tool-result") results.set(part.toolCallId, programResultOf(part.output));
      }
    }
    let resumed: ProgramRun = { ...program, pending: [] };
    const resolutions = [...program.resolutions];
    for (const call of batchCalls(batch)) {
      const result = results.get(call.toolCallId) ?? stoppedResultOf(call.toolCallId);
      resumed = withSettledCall(resumed, call, result);
      const pending = program.pending.find(({ callId }) => callId === call.toolCallId);
      if (pending !== undefined)
        resolutions.push({ interruptionId: pending.interruptionId, result });
    }
    next = withProgram(next, { ...resumed, resolutions });
  }
  return next;
}

function batchCalls(batch: SuspendedStep): ToolCallPart[] {
  return batch.messages.flatMap((message) =>
    message.role !== "assistant" || typeof message.content === "string"
      ? []
      : message.content.filter((part): part is ToolCallPart => part.type === "tool-call"),
  );
}

function notRun(): ProgramCallResult {
  return { error: "This call did not run.", outcome: "interrupted", status: "failed" };
}

// The transitions a program's steps apply. None reports a fact: a program is private execution
// state, and the calls it makes report themselves.

/** Programs join the turn, or replace the ones with their call ids. */
export function savePrograms(view: SessionView, programs: readonly ProgramRun[]): Transition {
  return transition({ events: [], turn: programs.reduce(withProgram, view.turn) });
}

/** A program leaves the turn, with whatever batch it still waited on: nothing runs it again. */
export function endProgram(view: SessionView, callId: string): Transition {
  return transition({ events: [], turn: withoutPrograms(view.turn, new Set([callId])) });
}

/**
 * The batch `program` waits on stops before its calls settled: each call without a result
 * counts as `stopped`, and the batch leaves the turn.
 */
export function stopProgramBatch(
  view: SessionView,
  program: Pick<ProgramRun, "callId">,
  stopped: ProgramCallResult,
): Transition {
  const batch = programBatch(view.turn, program);
  if (batch === undefined) return transition({ events: [], turn: view.turn });
  const suspended = view.turn.suspended.filter((step) => step !== batch);
  return transition({
    events: [],
    turn: resumePrograms({ ...view.turn, suspended }, [batch], () => stopped),
  });
}
