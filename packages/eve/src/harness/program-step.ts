import { asSchema, type ToolCallPart } from "ai";

import {
  agentLimitMessage,
  PROGRAM_MAX_CALLS,
  PROGRAM_MAX_INLINE_CALLS,
} from "#execution/code-mode/limits.js";
import {
  programFailure,
  programResult,
  truncateProgramModelOutput,
} from "#execution/code-mode/result.js";
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
import {
  createPresentedRuntimeActionRequestFromToolCall,
  projectToolLabel,
} from "#harness/action-presentation.js";
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
import { askStepApprovals, humanInputContext, stopForSignIn } from "#harness/hitl/index.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { frameworkToolNames } from "#harness/model-call/tools.js";
import {
  collectProgramWorkflowCalls,
  programCallKind,
  splitProgramAgentInput,
  withoutModelOutput,
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
import { checkToolCallInput } from "#harness/tool-call-io.js";
import { decideApproval, isRunnableTool } from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import { callRun, runTurn } from "#protocol/session-projection/selectors.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { toModelSchema } from "#tools/schema.js";

export const PROGRAM_STEERED_MESSAGE = "Stopped early because a new message arrived.";

const PROGRAM_TOOL_PRELUDE = [
  `const tools = new Proxy(Object.freeze({}), { get: (_target, name) => typeof name !== "string" || name === "then" || name === "toJSON" ? undefined : (input) => __bridge("call", { name, input: input === undefined ? {} : input }) });`,
  `const search = (input) => __bridge("search", { input });`,
  `const ctx = Object.freeze({ agent: (name, input) => __bridge("call", { name, input: input === undefined ? {} : input }) });`,
].join(" ");

type ParkedCall = { readonly call: ToolCallPart } & (
  | { readonly kind: "approval"; readonly ask: ApprovalAsk }
  | { readonly kind: "dispatch"; readonly clearance: Clearance }
  | { readonly kind: "sign-in"; readonly signIn: ToolSignIn }
);

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
    if (request.resumed !== undefined) {
      return await programOutput(catalog, name, request.resumed.resolution as ProgramCallResult);
    }
    const callId = programCallId(program.callId, request.index);
    const recovered = program.recovered?.[callId];
    if (recovered !== undefined && (recovered.started || recovered.outcome !== undefined)) {
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
      if (current.agentCalls >= program.maxSubagents) {
        throw new ProgramCallError(agentLimitMessage(program.maxSubagents, name));
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
      if (stopped()) throw new ProgramCallError(PROGRAM_STEERED_MESSAGE);
      return await executeToolCall(
        action,
        {
          abortSignal: step.config.abortSignal,
          approvalMemory: humanInputContext(step).approvalMemory,
          definition: withoutModelOutput(entry),
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
      callId: program.callId,
      code: program.code,
      errorName: "ToolError",
      handlers: {
        call: {
          handle: (request, payload) => call(request, readCall(payload)),
          label: "tools call",
        },
        search: {
          handle: (request, payload) => search(request, readSearch(payload)),
          label: "search()",
        },
      },
      prelude: PROGRAM_TOOL_PRELUDE,
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
      security: program.security,
    });
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    throw error;
  }
  throwIfTurnAborted(step.config.abortSignal);

  if (stopped()) return finishProgram(step, catalog, current, { error: PROGRAM_STEERED_MESSAGE });
  if (outcome.status !== "interrupted") return finishProgram(step, catalog, current, outcome);
  return parkProgram(step, catalog, current, outcome, parked);
}

export async function stopProgram(step: Step, program: ProgramRun): Promise<void> {
  const catalog = await stepCatalog(step);
  await startProgram(step, program, catalog);
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

async function startProgram(step: Step, program: ProgramRun, catalog: StepCatalog): Promise<void> {
  if (step.view().projection.view.calls[program.callId]?.status !== "requested") return;
  const definition = catalog.get(program.toolName);
  if (definition === undefined) return;
  const decision = await decideApproval(definition, {
    abortSignal: step.config.abortSignal,
    callId: program.callId,
    input: { js: program.code },
  });
  if (decision.clearance !== undefined) await step.publish(startCall(decision.clearance));
}

async function requestProgramCall(
  step: Step,
  program: ProgramRun,
  catalog: StepCatalog,
  toolCall: ToolCallPart,
): Promise<void> {
  const requested = step.view().projection.view.calls[toolCall.toolCallId];
  if (requested !== undefined) {
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
  const result = signIn === undefined ? park(step) : await stopForSignIn(step, signIn);
  return { ...result, checkpoint: true };
}

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
  await step.apply(endProgram(step.view(), program.callId));
  if (step.view().projection.view.calls[program.callId]?.status !== "settled") {
    await step.publish(
      settleCall(
        createRuntimeToolResultFromValue({
          callId: program.callId,
          isError: failed,
          output,
          toolName: program.toolName,
        }),
        {
          label: failed
            ? undefined
            : projectToolLabel(catalog.get(program.toolName), "complete", { js: "" }, output),
        },
      ),
    );
  }
  const part: ToolResultPart = {
    output: modelOutput(output, failed),
    toolCallId: program.callId,
    toolName: program.toolName,
    type: "tool-result",
  };
  await step.apply(settle(step.view(), { results: [{ part }] }));
  return { checkpoint: true, next: step.runStep, session: step.session };
}

function modelOutput(output: JsonObject, failed: boolean): ToolResultPart["output"] {
  const projected = truncateProgramModelOutput(output);
  if (projected.type === "text") {
    return { type: failed ? "error-text" : "text", value: projected.value };
  }
  return { type: failed ? "error-json" : "json", value: output };
}

function resultOf(part: ToolResultPart | undefined, output: unknown): ProgramCallResult {
  if (part === undefined) {
    return { error: "This call did not run.", outcome: "interrupted", status: "failed" };
  }
  const { type } = part.output;
  return type === "error-text" || type === "error-json" || type === "execution-denied"
    ? programResultOf(part.output)
    : { output: toJsonValue(output), status: "completed" };
}

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

function readCall(payload: unknown): { readonly name: string; readonly input: unknown } {
  if (!isObject(payload) || typeof payload.name !== "string" || payload.name === "") {
    throw new ProgramCallError("Call a tool as tools.<name>(input), by its exact name.");
  }
  return { input: payload.input, name: payload.name };
}

function readSearch(payload: unknown): unknown {
  return isObject(payload) ? payload.input : undefined;
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
