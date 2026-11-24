import { randomBytes } from "node:crypto";

import type { ModelMessage, ToolCallPart } from "ai";

import { TOOL_EXECUTION_DENIED_MESSAGE } from "#harness/approval-outcome.js";
import { toJsonValue } from "#harness/call-facts.js";
import { MAX_NOTED_CALLS, truncateNotedInput } from "#harness/interrupted-attempt.js";
import type { JsonValue } from "#shared/json.js";
import { transition, type Transition } from "./commit.js";
import type {
  ProgramCallResult,
  ProgramRun,
  ProgramUnfinishedCall,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "./state.js";
import type { ToolResultPart } from "./suspended-steps.js";
import type { SessionView } from "./view.js";

export type { ProgramCallResult, ProgramRun, ProgramUnfinishedCall } from "./state.js";

export function programCallId(programId: string, index: number): string {
  return `${programId}/${String(index)}`;
}

export function isProgramCall(programId: string, callId: string): boolean {
  return callId.startsWith(`${programId}/`);
}

const CONTINUATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export function newProgram(
  callId: string,
  toolName: string,
  input: unknown,
  event: StepCoordinates,
  maxSubagents: number,
): ProgramRun {
  const js = (input as { readonly js?: unknown } | null)?.js;
  return {
    agentCalls: 0,
    callId,
    code: typeof js === "string" ? js : "",
    counts: {},
    event,
    maxSubagents,
    pending: [],
    resolutions: [],
    security: {
      maxAgeMs: CONTINUATION_MAX_AGE_MS,
      signingKey: randomBytes(32).toString("base64url"),
    },
    toolName,
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

export function withProgram(turn: TurnState, program: ProgramRun): TurnState {
  const others = programsOf(turn).filter(({ callId }) => callId !== program.callId);
  return { ...turn, programs: [...others, program] };
}

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

export function programBatch(
  turn: Pick<TurnState, "suspended">,
  program: Pick<ProgramRun, "callId">,
): SuspendedStep | undefined {
  return turn.suspended.find((step) => step.program?.callId === program.callId);
}

export function runnableProgram(
  turn: TurnState,
  turnId: string | undefined,
): ProgramRun | undefined {
  return programsOf(turn).find(
    (program) => program.event.turnId === turnId && programBatch(turn, program) === undefined,
  );
}

export function batchCall(callId: string, toolName: string, input: unknown): ToolCallPart {
  return { input, toolCallId: callId, toolName, type: "tool-call" };
}

export function batchMessages(calls: readonly ToolCallPart[]): ModelMessage[] {
  return [{ content: [...calls], role: "assistant" }];
}

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

export function savePrograms(view: SessionView, programs: readonly ProgramRun[]): Transition {
  const ids = new Set(programs.map((program) => program.callId));
  const turn = programs.reduce(withProgram, view.turn);
  return transition({
    events: [],
    turn: {
      ...turn,
      suspended: turn.suspended.map((step) => stripApprovedProgramCalls(step, ids)),
    },
  });
}

function stripApprovedProgramCalls(step: SuspendedStep, ids: ReadonlySet<string>): SuspendedStep {
  if (step.approved === undefined || step.approved.length === 0) return step;
  const approved = step.approved.filter((entry) => !ids.has(entry.call.callId));
  if (approved.length === step.approved.length) return step;
  const { approved: _approved, ...rest } = step;
  return approved.length === 0 ? rest : { ...rest, approved };
}

export function endProgram(view: SessionView, callId: string): Transition {
  return transition({ events: [], turn: withoutPrograms(view.turn, new Set([callId])) });
}
