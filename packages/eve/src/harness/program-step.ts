import { asSchema, type ToolCallPart } from "ai";

import {
  agentLimitMessage,
  PROGRAM_MAX_AGENT_CALLS,
  PROGRAM_MAX_CALLS,
  PROGRAM_MAX_INLINE_CALLS,
  PROGRAM_MAX_RESULT_TOKENS,
} from "#execution/code-mode/limits.js";
import { programFailure, programResult } from "#execution/code-mode/result.js";
import {
  ProgramCallError,
  runProgramSandbox,
  type ProgramRequest,
  type ProgramSandboxOutcome,
} from "#execution/code-mode/sandbox.js";
import {
  programEntry,
  programInputIssue,
  programSearch,
} from "#execution/catalog/catalog-tools.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { stepCatalog } from "#definitions/step.js";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import { projectToolLabel } from "#harness/action-presentation.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  approvalRequest,
  executeToolCall,
  publishDenial,
  type ToolSignIn,
} from "#harness/call-executor.js";
import { toJsonValue } from "#harness/call-facts.js";
import type { Clearance } from "#harness/clearance.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { askStepApprovals, humanInputContext, stopForToolSignIn } from "#harness/hitl/index.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { frameworkToolNames } from "#harness/model-call/tools.js";
import {
  collectProgramWorkflowCalls,
  programCallKind,
  splitProgramAgentInput,
} from "#harness/program-calls.js";
import { requestCall, settleCall, startCall } from "#harness/session-machine/calls.js";
import {
  batchCall,
  batchMessages,
  endProgram,
  programCallId,
  programOf,
  programResultOf,
  savePrograms,
  stopProgramBatch,
  withSettledCall,
  type ProgramCallResult,
  type ProgramRun,
} from "#harness/session-machine/programs.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import type { ToolResultPart } from "#harness/session-machine/suspended-steps.js";
import {
  interruptedProgramCall,
  settle,
  suspendStep,
} from "#harness/session-machine/transitions.js";
import type { Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { checkToolCallInput } from "#harness/tool-call-io.js";
import { decideApproval, isRunnableTool } from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";
import { callRun, runTurn } from "#protocol/session-projection/selectors.js";
import { toErrorMessage } from "#shared/errors.js";
import { toModelSchema } from "#tools/schema.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

// A program step: one run of an `eve__execute` program, from where it last parked until it
// returns or parks again. The model step that read the call saved the program, so this step, and
// any retry of it, runs the same code under the same call id.
//
// Each `tools.<name>(input)` resolves through the step's catalog and runs on the path a model's
// own call takes: input validation, the entry's approval policy, then the tool. A call that can
// finish here runs here. A call that must wait, on a person's approval, a sign-in, a workflow
// run, or an agent, interrupts the program; the step ends with the program's continuation saved
// and those calls in a batch the session settles like a model response's, and the step that
// follows the batch resumes the program with their results.

/** What the model reads when a new message stops a program. */
export const PROGRAM_STEERED_MESSAGE = "Stopped early because a new message arrived.";

/** A call the program stopped on, with what the session needs to settle it. */
type ParkedCall = { readonly call: ToolCallPart } & (
  | { readonly kind: "approval"; readonly ask: ApprovalAsk }
  | { readonly kind: "dispatch"; readonly clearance: Clearance }
  | { readonly kind: "sign-in"; readonly signIn: ToolSignIn }
);

/**
 * Runs `program` until it returns or parks. Its nested calls publish as calls the `eve__execute`
 * call owns, each under an id that is the same on every resume and retry.
 */
export async function runProgramStep(step: Step, program: ProgramRun): Promise<StepResult> {
  const catalog = await stepCatalog(step);
  step.frameworkToolNames = frameworkToolNames(catalog);
  await startProgram(step, program, catalog);

  let current = program;
  const parked = new Map<number, ParkedCall>();
  const inline = createLimiter(PROGRAM_MAX_INLINE_CALLS);
  const telemetry = attemptTelemetry(step, program.callId);
  const steering = step.config.steeringSignal;
  const stopped = () => steering?.aborted === true;
  const settled = async (
    call: { readonly toolName: string; readonly input: unknown },
    result: ProgramCallResult,
  ) => {
    current = withSettledCall(current, call, result);
    return await programOutput(catalog, call.toolName, result);
  };

  const call = async (
    request: ProgramRequest,
    { input, name }: { readonly name: string; readonly input: unknown },
  ): Promise<JsonValue> => {
    // The step that follows a batch brings each parked call's result, already counted.
    if (request.resumed !== undefined) {
      return await programOutput(catalog, name, request.resumed.resolution as ProgramCallResult);
    }
    const callId = programCallId(program.callId, request.index);
    const recovered = program.recovered?.[callId];
    if (recovered !== undefined && (recovered.started || recovered.outcome !== undefined)) {
      // An interrupted attempt of this step already ran the call: it never runs twice.
      return await settled(
        { input, toolName: name },
        interruptedProgramCall(asInterruptedCall(recovered)),
      );
    }
    if (stopped()) throw new ProgramCallError(PROGRAM_STEERED_MESSAGE);
    if (request.index > PROGRAM_MAX_CALLS) throw new ProgramCallError(callLimitMessage(name));

    const resolved = programEntry(catalog.callable, name);
    if ("issue" in resolved) throw new ProgramCallError(resolved.issue);
    const { entry } = resolved;
    const kind = programCallKind(entry);
    const split = kind === "agent" ? splitProgramAgentInput(name, input) : { input };
    if ("issue" in split) throw new ProgramCallError(split.issue);
    const checked = await checkProgramInput(catalog, entry, split.input, callId);
    const toolInput: JsonObject =
      "outputSchema" in split && split.outputSchema !== undefined
        ? { ...checked, outputSchema: split.outputSchema }
        : checked;
    if (kind === "agent") {
      if (current.agentCalls >= PROGRAM_MAX_AGENT_CALLS) {
        throw new ProgramCallError(agentLimitMessage(PROGRAM_MAX_AGENT_CALLS, name));
      }
      current = { ...current, agentCalls: current.agentCalls + 1 };
    }

    const toolCall = batchCall(callId, name, toolInput);
    await requestProgramCall(step, program, catalog, toolCall);
    const action = { callId, input: toolInput, toolName: name };

    if (!isRunnableTool(entry)) {
      const decision = await decideApproval(entry, {
        abortSignal: step.config.abortSignal,
        approvalMemory: humanInputContext(step).approvalMemory,
        callId,
        input: toolInput,
      });
      if (decision.denied) {
        const denial = await publishDenial(action, {
          publish: step.publish,
          reason: decision.reason,
        });
        return await settled(action, resultOf(denial.settled[0]?.part, undefined));
      }
      parked.set(
        request.index,
        decision.awaitsPerson === true
          ? {
              ask: { ...approvalRequest(toolCall, entry), remember: decision.remember },
              call: toolCall,
              kind: "approval",
            }
          : {
              call: toolCall,
              clearance: requireDecisionClearance(decision.clearance, callId),
              kind: "dispatch",
            },
      );
      return request.interrupt();
    }

    const outcome = await inline(async () => {
      // A message that arrived while the call waited its turn stops it before it starts.
      if (stopped()) throw new ProgramCallError(PROGRAM_STEERED_MESSAGE);
      return await executeToolCall(
        action,
        {
          abortSignal: step.config.abortSignal,
          approvalMemory: humanInputContext(step).approvalMemory,
          definition: entry,
          messages: step.session.history,
          publish: step.publish,
          telemetry,
        },
        "evaluate",
      );
    });
    if (outcome.awaitsApproval === true) {
      parked.set(request.index, {
        ask: { ...approvalRequest(toolCall, entry), remember: outcome.remember },
        call: toolCall,
        kind: "approval",
      });
      return request.interrupt();
    }
    if (outcome.signIn !== undefined) {
      parked.set(request.index, { call: toolCall, kind: "sign-in", signIn: outcome.signIn });
      return request.interrupt();
    }
    return await settled(
      action,
      resultOf(outcome.settled[0]?.part, outcome.toolResults[0]?.output),
    );
  };

  const search = async (request: ProgramRequest, input: unknown): Promise<JsonValue> => {
    if (stopped()) throw new ProgramCallError(PROGRAM_STEERED_MESSAGE);
    if (request.index > PROGRAM_MAX_CALLS) throw new ProgramCallError(callLimitMessage("search"));
    try {
      return toJsonValue(await programSearch(catalog.callable, input));
    } catch (error) {
      throw new ProgramCallError(toErrorMessage(error));
    }
  };

  let outcome: ProgramSandboxOutcome;
  try {
    outcome = await runProgramSandbox({
      abortSignal: step.config.abortSignal,
      call,
      callId: program.callId,
      code: program.code,
      resume:
        program.continuation === undefined
          ? undefined
          : {
              continuation: program.continuation,
              resolutions: program.resolutions.map(({ interruptionId, result }) => ({
                interruptionId,
                value: result,
              })),
            },
      search,
      security: program.security,
    });
  } catch (error) {
    // Only the turn's cancellation rejects the run; the cancel settles the call and its calls.
    throwIfTurnAborted(step.config.abortSignal);
    throw error;
  }
  throwIfTurnAborted(step.config.abortSignal);

  // A message that arrived while the program ran stops it: the calls it ran keep their results,
  // and whatever it parked on never starts.
  if (stopped()) return finishProgram(step, catalog, current, { error: PROGRAM_STEERED_MESSAGE });
  if (outcome.status !== "interrupted") return finishProgram(step, catalog, current, outcome);
  return parkProgram(step, catalog, current, outcome, parked);
}

/**
 * Stops a program a new message steers past: its `eve__execute` call settles with what its calls
 * did so far, and the writer closes whatever it still waited on.
 */
export async function stopProgram(step: Step, program: ProgramRun): Promise<void> {
  const catalog = await stepCatalog(step);
  await startProgram(step, program, catalog);
  // The calls it still waited on count as interrupted: none of them ran.
  await step.apply(
    stopProgramBatch(step.view(), program, {
      error: PROGRAM_STEERED_MESSAGE,
      outcome: "interrupted",
      status: "failed",
    }),
  );
  const stopped = programOf(step.view().turn, program.callId) ?? program;
  await finishProgram(step, catalog, stopped, { error: PROGRAM_STEERED_MESSAGE });
}

/** The `eve__execute` call starts with its first program step, cleared like any ungated call. */
async function startProgram(step: Step, program: ProgramRun, catalog: StepCatalog): Promise<void> {
  // A retried step finds the call its interrupted attempt already started.
  if (step.view().projection.view.calls[program.callId]?.status !== "requested") return;
  const definition = catalog.get(EXECUTE_TOOL_NAME);
  if (definition === undefined) return;
  const decision = await decideApproval(definition, {
    abortSignal: step.config.abortSignal,
    callId: program.callId,
    input: { code: program.code },
  });
  if (decision.clearance !== undefined) await step.publish(startCall(decision.clearance));
}

/** A program's call is requested once, under its catalog name, owned by the `eve__execute` call. */
async function requestProgramCall(
  step: Step,
  program: ProgramRun,
  catalog: StepCatalog,
  toolCall: ToolCallPart,
): Promise<void> {
  const requested = step.view().projection.view.calls[toolCall.toolCallId];
  if (requested !== undefined) {
    // An interrupted attempt requested the call and never started it: it runs now, as that call.
    if (requested.capability.name === toolCall.toolName && requested.status === "requested") return;
    throw new ProgramCallError(
      `EXECUTE_REPLAY_DIVERGED: after an interruption the program made a different call than before, so "${toolCall.toolName}" was not called. Programs must make the same calls when they run again.`,
    );
  }
  const { action, hidden, presentationLabel } = createPresentedRuntimeActionRequestFromToolCall({
    toolCall: toolCall as never,
    tools: catalog,
  });
  await step.publish(
    requestCall({ action, hidden, label: presentationLabel, owner: { callId: program.callId } }),
  );
}

/** The input as the entry's schema takes it, or what the program reads when it doesn't. */
async function checkProgramInput(
  catalog: StepCatalog,
  entry: HarnessToolDefinition,
  input: unknown,
  callId: string,
): Promise<JsonObject> {
  const checked = await checkToolCallInput(entry, input, callId);
  if (checked.kind === "valid") return checked.value;
  throw new ProgramCallError(
    checked.kind === "threw"
      ? toErrorMessage(checked.error)
      : programInputIssue(catalog.callable, entry, checked.message),
  );
}

/**
 * The program parked: its continuation is saved, and the calls it stopped on wait in a batch the
 * session settles exactly as it settles a model response's calls.
 */
async function parkProgram(
  step: Step,
  catalog: StepCatalog,
  program: ProgramRun,
  outcome: Extract<ProgramSandboxOutcome, { readonly status: "interrupted" }>,
  parked: ReadonlyMap<number, ParkedCall>,
): Promise<StepResult> {
  const pending = outcome.pending.map(({ index, interruptionId }) => {
    const call = parked.get(index);
    if (call === undefined) {
      throw new Error(`Program call ${String(index)} stopped the program without a reason.`);
    }
    return { call, interruptionId };
  });
  const { recovered: _recovered, ...kept } = program;
  const next: ProgramRun = {
    ...kept,
    continuation: outcome.continuation,
    pending: pending.map(({ call, interruptionId }) => ({
      callId: call.call.toolCallId,
      interruptionId,
    })),
    resolutions: [],
  };
  await step.apply(savePrograms(step.view(), [next]));

  const calls = pending.map(({ call }) => call);
  const requests = calls.flatMap((call) => (call.kind === "approval" ? [call.ask] : []));
  const batch = {
    event: program.event,
    messages: batchMessages(calls.map(({ call }) => call)),
    program: { callId: program.callId },
    tasks: collectProgramWorkflowCalls(
      calls.flatMap((call) =>
        call.kind === "dispatch"
          ? [
              {
                callId: call.call.toolCallId,
                clearance: call.clearance,
                input: call.call.input as JsonObject,
                toolName: call.call.toolName,
              },
            ]
          : [],
      ),
      catalog,
    ),
  };
  if (requests.length > 0) {
    await askStepApprovals(step, { ...batch, requests, tools: catalog });
  } else {
    await step.apply(suspendStep(step.view(), batch));
  }
  const signIn = resolveInlineAuthorizationInterrupt({
    signIns: calls.flatMap((call) => (call.kind === "sign-in" ? [call.signIn] : [])),
  });
  const result = signIn === undefined ? park(step) : await stopForToolSignIn(step, signIn);
  return { ...result, checkpoint: true };
}

/**
 * The program ended: its `eve__execute` call settles with the one value the model reads, and the
 * step that made the call gets its result.
 */
async function finishProgram(
  step: Step,
  catalog: StepCatalog,
  program: ProgramRun,
  outcome:
    | { readonly error: string; readonly logs?: readonly string[] }
    | { readonly result: JsonValue; readonly logs?: readonly string[] },
): Promise<StepResult> {
  const failed = "error" in outcome;
  const output: JsonObject = {
    ...programResult(
      failed && outcome.error !== PROGRAM_STEERED_MESSAGE
        ? { ...outcome, error: programFailure(outcome.error, program.counts) }
        : outcome,
      program.counts,
    ),
    ...(program.unfinished.length > 0 && {
      notCompleted: program.unfinished.map((call) => ({ ...call })),
    }),
  };
  // The program leaves the turn before its call settles: nothing runs it again.
  await step.apply(endProgram(step.view(), program.callId));
  // A step that runs again after its attempt settled the call replays to the same result, which
  // the stream already holds.
  if (step.view().projection.view.calls[program.callId]?.status !== "settled") {
    await step.publish(
      settleCall(
        createRuntimeToolResultFromValue({
          callId: program.callId,
          isError: failed,
          output,
          toolName: EXECUTE_TOOL_NAME,
        }),
        {
          label: failed
            ? undefined
            : projectToolLabel(catalog.get(EXECUTE_TOOL_NAME), "complete", { code: "" }, output),
        },
      ),
    );
  }
  const part: ToolResultPart = {
    output: modelOutput(output, failed),
    toolCallId: program.callId,
    toolName: EXECUTE_TOOL_NAME,
    type: "tool-result",
  };
  await step.apply(settle(step.view(), { results: [{ part }] }));
  return { checkpoint: true, next: step.runStep, session: step.session };
}

/** What reaches the model of a program's result: all of it, or its head and tail. */
function modelOutput(output: JsonObject, failed: boolean): ToolResultPart["output"] {
  if (estimateTokens(output) <= PROGRAM_MAX_RESULT_TOKENS) {
    return failed ? { type: "error-json", value: output } : { type: "json", value: output };
  }
  const text = JSON.stringify(output);
  // About four characters to a token; the head carries the result's shape, the tail its counts.
  const budget = PROGRAM_MAX_RESULT_TOKENS * 4;
  const head = text.slice(0, Math.floor(budget * 0.75));
  const tail = text.slice(text.length - Math.floor(budget * 0.25));
  const dropped = text.length - head.length - tail.length;
  const value = `${head}\n… (${String(dropped)} characters left out: the program's result is over ${String(PROGRAM_MAX_RESULT_TOKENS)} tokens. Return only what you need.) …\n${tail}`;
  return { type: failed ? "error-text" : "text", value };
}

/** One call's result as the program reads it: the tool's own output, never its model projection. */
function resultOf(part: ToolResultPart | undefined, output: unknown): ProgramCallResult {
  if (part === undefined) {
    return { error: "This call did not run.", outcome: "interrupted", status: "failed" };
  }
  const { type } = part.output;
  return type === "error-text" || type === "error-json" || type === "execution-denied"
    ? programResultOf(part.output)
    : // The stream reports the same JSON, so a step that runs again replays the same value.
      { output: toJsonValue(output), status: "completed" };
}

/**
 * What the program reads of one call: the tool's output, or a rejection it can catch. An entry
 * that declares an output schema is held to it, so a program never reads a shape its signature
 * doesn't advertise.
 */
async function programOutput(
  catalog: StepCatalog,
  name: string,
  result: ProgramCallResult,
): Promise<JsonValue> {
  if (result.status !== "completed") throw new ProgramCallError(result.error);
  const resolved = programEntry(catalog.callable, name);
  const outputSchema = "entry" in resolved ? resolved.entry.outputSchema : undefined;
  if (outputSchema === undefined) return result.output;
  const schema = asSchema(toModelSchema(outputSchema, "output"));
  const checked = await schema.validate?.(result.output);
  if (checked === undefined || checked.success) return result.output;
  throw new ProgramCallError(
    `InvalidToolOutput: "${name}" returned a value that doesn't match its output schema: ${toErrorMessage(checked.error)}`,
  );
}

function asInterruptedCall(call: NonNullable<ProgramRun["recovered"]>[string]) {
  return { ...call, outcome: call.outcome as never };
}

function requireDecisionClearance(clearance: Clearance | undefined, callId: string): Clearance {
  if (clearance === undefined) throw new Error(`Call "${callId}" has no clearance to dispatch.`);
  return clearance;
}

function callLimitMessage(name: string): string {
  return `EXECUTE_CALL_LIMIT_REACHED: a program may make at most ${String(PROGRAM_MAX_CALLS)} calls; "${name}" was not called.`;
}

/** The AI SDK telemetry of the model attempt that made the `eve__execute` call. */
function attemptTelemetry(step: Step, callId: string) {
  const view = step.view().projection.view;
  const call = view.calls[callId];
  const runId = call === undefined ? undefined : callRun(view, call);
  const run = runId === undefined ? undefined : view.runs[runId];
  if (run?.attempt === undefined) return undefined;
  return step.instrumentation?.prepareAttempt({
    attempt: run.attempt,
    isFrameworkTool: (name) => step.frameworkToolNames.has(name),
    runId: run.runId,
    stepIndex: run.step,
    turnId: runTurn(view, run.runId),
  }).telemetry;
}

/** Runs at most `limit` tasks at once, in the order they asked. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}
