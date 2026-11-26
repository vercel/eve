import type { ApprovalMemory, RememberRequest } from "#approval/evaluation.js";
import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { TaskPromotionAllowedKey } from "#context/keys.js";
import { approvedClearance, type Clearance } from "#harness/clearance.js";
import type { SessionView } from "#harness/session-machine/view.js";
import {
  asSchema,
  generateId,
  type ModelMessage,
  type Telemetry,
  type TelemetryOptions,
  type ToolResultPart,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from "ai";

import { type SkillLoadResultPart, skillLoadProvenance } from "#execution/catalog/skills.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  modelFacingAuthorizationOutput,
} from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { failedCall, TOOL_EXECUTION_DENIED_MESSAGE } from "#harness/approval-outcome.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import { isInvalidToolCall } from "#harness/tool-call-input-errors.js";
import { decideApproval, invokeTool, isRunnableTool, type RunnableTool } from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";
import type { HandleEventFn, HarnessToolLookup } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { callProgress } from "#harness/call-facts.js";
import { settleCall, startCall } from "#harness/session-machine/calls.js";
import { withUsageCall } from "#harness/usage-sink.js";
import { withModelCall } from "#runtime/connections/identity-hold.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import { toModelSchema } from "#tools/schema.js";
import { isTaskPromotion, type PromotedTaskCall } from "#tools/task-handoff.js";
import { projectToolLabel } from "#harness/action-presentation.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";

export interface CallResult {
  readonly part: SkillLoadResultPart;
}

const log = createLogger("harness.tool-loop");

export const APPROVED_CALL_INTERRUPTED_MESSAGE =
  "The turn was cancelled while this approved tool call was running. It may have partially run; it was not retried.";

type CallApproval = "recheck" | "evaluate";

export interface ToolSignIn {
  readonly callId: string;
  readonly input: unknown;
  readonly toolName: string;
  readonly signal: AuthorizationSignal;
  readonly version?: string;
}

export interface CallOutcome {
  readonly callerOnly?: true;
  readonly remember?: RememberRequest;
  readonly clearance?: Clearance;
  readonly promoted?: PromotedTaskCall;
  readonly settled: readonly CallResult[];
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
  readonly awaitsApproval?: true;
  readonly signIn?: ToolSignIn;
}

export async function executeToolCall(
  call: { readonly callId: string; readonly input: unknown; readonly toolName: string },
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly approvalMemory?: ApprovalMemory;
    readonly definition: RunnableTool;
    readonly messages: readonly ModelMessage[];
    readonly publish: HandleEventFn;
    readonly telemetry?: TelemetryOptions;
    readonly modelCallId?: string;
    readonly beforeExecute?: () => void;
    readonly view?: () => Pick<SessionView, "projection">;
    readonly responder?: SessionAuthContext;
    readonly beforeResult?: (result: {
      readonly failure: Error | string | undefined;
      readonly invoked: boolean;
    }) => Promise<void>;
  },
  approval: CallApproval,
): Promise<CallOutcome> {
  const { callId, toolName, input: args } = call;
  const { definition } = input;
  const settled: CallResult[] = [];
  const toolResults: TypedToolResult<ToolSet>[] = [];
  let started = false;
  let invoked = false;
  let completed: CallResult | undefined;
  try {
    throwIfTurnAborted(input.abortSignal);
    const validation =
      approval === "recheck"
        ? await asSchema(toModelSchema(definition.inputSchema, "input")).validate?.(args)
        : undefined;
    if (validation?.success === false) {
      const message = `The approved input is no longer valid for tool "${toolName}". Request a new tool call and approval.`;
      await input.beforeResult?.({ failure: message, invoked });
      await input.publish(
        settleCall(
          createRuntimeToolResultFromValue({ callId, isError: true, output: message, toolName }),
          {},
        ),
      );
      return {
        settled: [
          {
            part: {
              type: "tool-result" as const,
              toolCallId: callId,
              toolName,
              output: { type: "error-text" as const, value: message },
            },
          },
        ],
        toolResults,
      };
    }
    const decision = await decideApproval(definition, {
      abortSignal: input.abortSignal,
      callId,
      input: args,
      approvalMemory: input.approvalMemory,
      recheck: approval === "recheck",
    });
    if (decision.awaitsPerson === true)
      return {
        awaitsApproval: true,
        ...(decision.callerOnly === true && { callerOnly: true as const }),
        remember: decision.remember,
        settled,
        toolResults,
      };
    if (decision.denied) {
      await input.beforeResult?.({
        failure: decision.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
        invoked,
      });
      const denial = await publishDenial(
        { callId, input: args, toolName },
        { publish: input.publish, reason: decision.reason },
      );
      return { settled: [...settled, ...denial.settled], toolResults };
    }
    const clearance =
      (approval === "recheck" && input.view !== undefined
        ? approvedClearance(input.view().projection.view, callId)
        : undefined) ?? decision.clearance;
    if (clearance === undefined) throw new Error(`Call "${callId}" has no clearance to run.`);
    let output: unknown;
    let failed = false;
    let failure = "";
    let thrown: Error | undefined;
    const telemetry = toolTelemetry(input.telemetry, {
      callId: input.modelCallId ?? `approved:${callId}`,
      messages: [...input.messages],
      toolCall: { input: args, toolCallId: callId, toolName, type: "tool-call" },
    });
    input.beforeExecute?.();
    await telemetry.started();
    let executionMs = 0;
    const executeOptions = {
      ...(input.responder !== undefined && { approval: { responder: input.responder } }),
      abortSignal: input.abortSignal,
      messages: [...input.messages],
      toolCallId: callId,
    };
    try {
      await telemetry.execute(async () => {
        const startedAt = performance.now();
        try {
          started = true;
          await input.publish(startCall(clearance));
          const run = async () => {
            invoked = true;
            const executed = invokeTool(definition, args, executeOptions, clearance);
            const abandon = approval === "evaluate" ? input.abortSignal : undefined;
            if (isAsyncIterable(executed)) {
              for await (const partial of untilAborted(executed, abandon)) {
                output = partial;
                const visible = withoutSignInSecrets(partial);
                await input.publish(
                  callProgress(
                    callId,
                    visible,
                    projectToolLabel(definition, "delta", args, visible),
                  ),
                );
              }
            } else {
              output = await raceAbort(Promise.resolve(executed), abandon);
            }
          };
          await withUsageCall(callId, () => withModelCall(run));
        } finally {
          executionMs = performance.now() - startedAt;
        }
      });
    } catch (error) {
      await telemetry.ended(
        { error, input: args, toolCallId: callId, toolName, type: "tool-error" },
        executionMs,
      );
      throwIfSessionStreamDead(error);
      throwIfTurnAborted(input.abortSignal);
      logError(log, "tool execution failed", error, { toolName, toolCallId: callId });
      failed = true;
      thrown = toError(error);
      output = thrown.message;
      failure = modelFacingError(error);
    }
    if (!failed) {
      await telemetry.ended(
        {
          input: args,
          output: withoutSignInSecrets(output),
          toolCallId: callId,
          toolName,
          type: "tool-result",
        },
        executionMs,
      );
    }
    if (!failed && isAuthorizationSignal(output)) {
      const signIn = { callId, input: args, signal: output, toolName };
      return {
        settled,
        signIn:
          definition.version === undefined ? signIn : { ...signIn, version: definition.version },
        toolResults,
      };
    }
    if (!failed && isTaskPromotion(output)) {
      return {
        promoted: {
          callId,
          clearance,
          handoff: output.handoff,
          input: args,
          ...(output.preview !== undefined && { preview: output.preview }),
          toolName,
          workflowId: output.workflowId,
        },
        settled,
        toolResults,
      };
    }
    toolResults.push({
      input: args,
      output,
      toolCallId: callId,
      toolName,
      type: "tool-result",
    } as TypedToolResult<ToolSet>);
    const modelOutput = failed
      ? { type: "error-text" as const, value: failure }
      : await toolCallModelOutput(definition, output, callId);
    const skillLoad = modelOutput.type === "text" ? skillLoadProvenance(executeOptions) : undefined;
    completed = {
      part: {
        output: modelOutput,
        ...(skillLoad !== undefined && { skillLoad }),
        toolCallId: callId,
        toolName,
        type: "tool-result",
      },
    };
    settled.push(completed);
    await input.beforeResult?.({ failure: failed ? thrown : undefined, invoked });
    await input.publish(
      settleCall(
        createRuntimeToolResultFromValue({
          callId,
          isError: failed,
          output: thrown ?? output,
          toolName,
        }),
        {
          label: failed ? undefined : projectToolLabel(definition, "complete", args, output),
        },
      ),
    );
    return { settled, toolResults };
  } catch (error) {
    throwIfSessionStreamDead(error);
    if (input.abortSignal?.aborted === true) {
      if (!started) throwIfTurnAborted(input.abortSignal);
      if (completed !== undefined) return { settled: [completed], toolResults };
      return { settled: [interruptedResult(callId, toolName)], toolResults };
    }
    const failure = toError(error);
    logError(log, "tool call failed", error, { toolName, toolCallId: callId });
    await input.beforeResult?.({ failure, invoked });
    const failed = failedCall({ callId, toolName, message: failure });
    await input.publish(settleCall(failed.result));
    return { settled: [{ part: failed.part }], toolResults };
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  promise.catch(() => {});
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

async function* untilAborted<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let done = false;
  try {
    while (true) {
      const next = await raceAbort(iterator.next(), signal);
      if (next.done === true) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done && iterator.return !== undefined)
      await raceAbort(Promise.resolve(iterator.return()), signal);
  }
}

function modelFacingError(error: unknown): string {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.toString();
  return JSON.stringify(error);
}

function withoutSignInSecrets(output: unknown): unknown {
  return isAuthorizationSignal(output) ? modelFacingAuthorizationOutput(output) : output;
}

function interruptedResult(callId: string, toolName: string): CallResult {
  return {
    part: {
      output: { type: "error-text", value: APPROVED_CALL_INTERRUPTED_MESSAGE },
      toolCallId: callId,
      toolName,
      type: "tool-result",
    },
  };
}

type ToolExecutionStart = Parameters<NonNullable<Telemetry["onToolExecutionStart"]>>[0];
type ToolExecutionEnd = Parameters<NonNullable<Telemetry["onToolExecutionEnd"]>>[0];

function toolTelemetry(
  telemetry: TelemetryOptions | undefined,
  execution: Pick<ToolExecutionStart, "callId" | "messages" | "toolCall">,
): {
  readonly started: () => Promise<void>;
  readonly execute: (execute: () => PromiseLike<void>) => Promise<void>;
  readonly ended: (
    toolOutput: ToolExecutionEnd["toolOutput"],
    toolExecutionMs: number,
  ) => Promise<void>;
} {
  const integrations =
    telemetry === undefined || telemetry.isEnabled === false
      ? []
      : [telemetry.integrations ?? []].flat();
  const hideInputs = telemetry?.recordInputs === false;
  const hideOutputs = telemetry?.recordOutputs === false;
  const recorded = (toolOutput: ToolExecutionEnd["toolOutput"]): ToolExecutionEnd["toolOutput"] => {
    if (!hideInputs && !hideOutputs) return toolOutput;
    const kept: Record<string, unknown> = { ...toolOutput };
    if (hideInputs) kept.input = undefined;
    if (hideOutputs) {
      kept.output = undefined;
      kept.error = undefined;
    } else if (kept.error != null) {
      kept.error = new Error("AI SDK operation failed");
    }
    return kept as ToolExecutionEnd["toolOutput"];
  };
  const event = {
    ...execution,
    messages: hideInputs ? [] : execution.messages,
    toolCall: hideInputs ? { ...execution.toolCall, input: undefined } : execution.toolCall,
    functionId: telemetry?.functionId,
    recordInputs: telemetry?.recordInputs,
    recordOutputs: telemetry?.recordOutputs,
    toolContext: undefined,
  } as ToolExecutionStart;
  const notify = async (callback: (integration: Telemetry) => unknown) => {
    await Promise.allSettled(integrations.map(async (integration) => await callback(integration)));
  };
  return {
    started: () => notify((integration) => integration.onToolExecutionStart?.(event)),
    execute: async (execute) => {
      let wrapped: () => PromiseLike<void> = execute;
      for (const integration of integrations) {
        if (integration.executeTool === undefined) continue;
        const inner = wrapped;
        wrapped = () =>
          integration.executeTool!({
            ...event,
            execute: inner,
            toolCallId: execution.toolCall.toolCallId,
          });
      }
      await wrapped();
    },
    ended: (toolOutput, toolExecutionMs) =>
      notify((integration) =>
        integration.onToolExecutionEnd?.({
          ...event,
          toolExecutionMs,
          toolOutput: recorded(toolOutput),
        } as ToolExecutionEnd),
      ),
  };
}

export interface InlineCallResults {
  readonly parts: readonly ToolResultPart[];
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
  readonly approvals: readonly ApprovalAsk[];
  readonly promotedTasks: readonly PromotedTaskCall[];
  readonly signIns: readonly ToolSignIn[];
  readonly policyApprovals?: Readonly<Record<string, Clearance>>;
}

export const NO_INLINE_CALLS: InlineCallResults = {
  approvals: [],
  parts: [],
  promotedTasks: [],
  signIns: [],
  toolResults: [],
};

export async function executeInlineCalls(input: {
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
  readonly excludedCallIds: ReadonlySet<string>;
  readonly tools: HarnessToolLookup;
  readonly approvalMemory: ApprovalMemory;
  readonly messages: readonly ModelMessage[];
  readonly publish: HandleEventFn;
  readonly abortSignal: AbortSignal | undefined;
  readonly telemetry?: TelemetryOptions;
  readonly modelCallId?: string;
  readonly beforeExecute: () => void;
}): Promise<InlineCallResults> {
  const calls = input.toolCalls.filter(
    (call) =>
      call.providerExecuted !== true &&
      !isInvalidToolCall(call) &&
      !input.excludedCallIds.has(call.toolCallId) &&
      input.tools.get(call.toolName) !== undefined,
  );
  const store = contextStorage.getStore();
  const previousPromotion = store?.get(TaskPromotionAllowedKey);
  store?.setVirtualContext(TaskPromotionAllowedKey, true);
  let finished: PromiseSettledResult<{
    call: TypedToolCall<ToolSet>;
    executed: CallOutcome;
    approval?: ApprovalAsk;
  }>[];
  try {
    finished = await Promise.allSettled(
      calls.map(
        async (
          call,
        ): Promise<{
          call: TypedToolCall<ToolSet>;
          executed: CallOutcome;
          approval?: ApprovalAsk;
        }> => {
          const definition = input.tools.get(call.toolName)!;
          const action = { callId: call.toolCallId, input: call.input, toolName: call.toolName };
          try {
            const executed = isRunnableTool(definition)
              ? await executeToolCall(action, { ...input, definition }, "evaluate")
              : await decideDeferredCall(action, definition, input);
            const approval =
              executed.awaitsApproval === true
                ? {
                    ...approvalRequest(call, definition),
                    ...(executed.callerOnly === true && { callerOnly: true as const }),
                    remember: executed.remember,
                  }
                : undefined;
            return { call, executed, approval };
          } catch (error) {
            throwIfSessionStreamDead(error);
            throwIfTurnAborted(input.abortSignal);
            const failed = failedCall({ ...action, message: toError(error) });
            await input.publish(settleCall(failed.result));
            return { call, executed: { settled: [{ part: failed.part }], toolResults: [] } };
          }
        },
      ),
    );
  } finally {
    if (store !== undefined) {
      if (previousPromotion === undefined) store.delete(TaskPromotionAllowedKey);
      else store.setVirtualContext(TaskPromotionAllowedKey, previousPromotion);
    }
  }
  const rejected = finished.find((call) => call.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  const executed = finished.flatMap((call) => (call.status === "fulfilled" ? [call.value] : []));
  return {
    policyApprovals: Object.fromEntries(
      executed.flatMap(({ call, executed }) =>
        executed.clearance === undefined ? [] : [[call.toolCallId, executed.clearance]],
      ),
    ),
    approvals: executed.flatMap(({ approval }) => (approval === undefined ? [] : [approval])),
    parts: executed.flatMap(({ executed }) => executed.settled.map((result) => result.part)),
    promotedTasks: executed.flatMap(({ executed }) =>
      executed.promoted === undefined ? [] : [executed.promoted],
    ),
    signIns: executed.flatMap(({ executed }) =>
      executed.signIn === undefined ? [] : [executed.signIn],
    ),
    toolResults: executed.flatMap(({ executed }) => executed.toolResults),
  };
}

async function decideDeferredCall(
  call: { readonly callId: string; readonly input: unknown; readonly toolName: string },
  definition: HarnessToolDefinition,
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly approvalMemory: ApprovalMemory;
    readonly publish: HandleEventFn;
  },
): Promise<CallOutcome> {
  const decision = await decideApproval(definition, {
    abortSignal: input.abortSignal,
    approvalMemory: input.approvalMemory,
    callId: call.callId,
    input: call.input,
  });
  if (decision.awaitsPerson === true)
    return {
      awaitsApproval: true,
      ...(decision.callerOnly === true && { callerOnly: true as const }),
      remember: decision.remember,
      settled: [],
      toolResults: [],
    };
  if (!decision.denied)
    return {
      settled: [],
      toolResults: [],
      clearance: decision.clearance,
    };
  return await publishDenial(call, {
    publish: input.publish,
    reason: decision.reason,
  });
}

export async function publishDenial(
  call: { readonly callId: string; readonly input: unknown; readonly toolName: string },
  input: {
    readonly publish: HandleEventFn;
    readonly reason: string | undefined;
  },
): Promise<CallOutcome> {
  const part = {
    output: { reason: input.reason, type: "execution-denied" },
    toolCallId: call.callId,
    toolName: call.toolName,
    type: "tool-result",
  } satisfies ToolResultPart;
  await input.publish(
    settleCall(
      {
        callId: call.callId,
        isError: true,
        kind: "tool-result",
        output: {
          code: "TOOL_EXECUTION_DENIED",
          message: input.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
          tool: { result: "not_run" },
        },
        toolName: call.toolName,
      },
      { rejected: true },
    ),
  );
  return { settled: [{ part }], toolResults: [] };
}

export function approvalRequest(
  call: Pick<TypedToolCall<ToolSet>, "input" | "toolCallId" | "toolName">,
  definition: HarnessToolDefinition | undefined,
): ApprovalAsk {
  const { toolCallId: callId, toolName } = call;
  const input = resolveToolCallInputObject(call.input, { callId, toolName });
  const label = projectToolLabel(definition, "start", input) ?? displayTitle(toolName);
  const prompt = authoredApprovalPrompt(call, definition);
  return {
    call: {
      callId,
      input,
      toolName,
      ...(definition?.version !== undefined && { version: definition.version }),
    },
    interactionId: generateId(),
    request: {
      allowFreeform: false,
      display: "confirmation",
      kind: "approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      prompt: prompt ?? `Approve ${label}?`,
    },
  };
}

function authoredApprovalPrompt(
  call: Pick<TypedToolCall<ToolSet>, "input" | "toolCallId" | "toolName">,
  definition: HarnessToolDefinition | undefined,
): string | undefined {
  const approval = definition?.approval;
  if (approval === undefined || typeof approval === "function") return undefined;
  const input =
    typeof call.input === "object" && call.input !== null && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};
  const prompt = approval.prompt?.({ callId: call.toolCallId, input, toolName: call.toolName });
  if (prompt !== undefined && typeof prompt !== "string") {
    throw new Error(`Tool "${call.toolName}" approval prompt must return a string.`);
  }
  return prompt;
}
