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

import {
  createRuntimeToolResultFromMessagePart,
  createRuntimeToolResultFromValue,
  toActionResult,
} from "#harness/action-result-helpers.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  modelFacingAuthorizationOutput,
} from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { TOOL_EXECUTION_DENIED_MESSAGE } from "#harness/input-request-resolution.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import { isInvalidToolCall } from "#harness/tool-call-input-errors.js";
import { projectDeltaPresentation, projectResultPresentation } from "#harness/tool-presentation.js";
import {
  decideApproval,
  invokeTool,
  isRunnableTool,
  recheckApprovedCall,
  type RunnableTool,
} from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { HandleEventFn, HarnessToolLookup } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { createActionPartialEvent, createActionResultEvent } from "#protocol/message.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import type { InputRequest } from "#shared/input.js";
import { parseJsonObject } from "#shared/json.js";
import { toModelSchema } from "#tools/schema.js";
import { projectToolStartLabel } from "#harness/action-presentation.js";
import { displayTitle } from "#shared/display-name.js";

// eve runs every local call itself: the AI SDK only calls the model. The calls a model response
// makes run here as soon as the response ends, and so do the calls a person approved later.

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
/** A call's result, as the model reads it. */
export interface CallResult {
  readonly part: Extract<ToolResponsePart, { type: "tool-result" }>;
}

const log = createLogger("harness.tool-loop");

/** What the model reads for an approved call the turn's cancellation cut short. */
export const APPROVED_CALL_INTERRUPTED_MESSAGE =
  "The turn was cancelled while this approved tool call was running. It may have partially run; it was not retried.";

/** How a call's approval is decided before it runs. */
type CallApproval =
  /** A person approved it; the policy may still refuse it now. */
  | "recheck"
  /** The model just made it; the policy decides whether it runs, waits for a person, or is denied. */
  | "evaluate";

/** A call that stopped for a sign-in: the tool returned the challenge instead of a result. */
export interface ToolSignIn {
  readonly callId: string;
  readonly signal: AuthorizationSignal;
}

/** How one call came out: its result for the model, or what it waits on instead. */
export interface CallOutcome {
  readonly settled: readonly CallResult[];
  /** What `execute` returned, for `endsTurn`. */
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
  readonly awaitsApproval?: true;
  readonly signIn?: ToolSignIn;
}

/**
 * Runs one local call: it decides the approval, streams the call's progress and result, and
 * returns the result the model reads. A call a person approved revalidates its input first.
 */
export async function executeToolCall(
  call: { readonly callId: string; readonly input: unknown; readonly toolName: string },
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly approvedTools?: ReadonlySet<string>;
    readonly definition: RunnableTool;
    readonly messages: readonly ModelMessage[];
    readonly position: {
      readonly sequence: number;
      readonly stepIndex: number;
      readonly turnId: string;
    };
    readonly publish: HandleEventFn;
    readonly telemetry?: TelemetryOptions;
    /** The AI SDK's ID for the model call that made a fresh call. */
    readonly modelCallId?: string;
    /** Runs just before the tool does, as the step's steering protection. */
    readonly beforeExecute?: () => void;
  },
  approval: CallApproval,
): Promise<CallOutcome> {
  const { callId, toolName, input: args } = call;
  const { definition } = input;
  const at = {
    sequence: input.position.sequence,
    stepIndex: input.position.stepIndex,
    turnId: input.position.turnId,
  };
  const settled: CallResult[] = [];
  const toolResults: TypedToolResult<ToolSet>[] = [];
  // Once the tool runs, the call settles even if the turn is cancelled: a result reaches the
  // session, so it never runs a call with side effects a second time.
  let started = false;
  let completed: CallResult | undefined;
  try {
    throwIfTurnAborted(input.abortSignal);
    // The stored input revalidates against the tool's current schema and runs unchanged, so the
    // call that runs is the one the person approved. A model's fresh call was validated as parsed.
    const validation =
      approval === "recheck"
        ? await asSchema(toModelSchema(definition.inputSchema, "input")).validate?.(args)
        : undefined;
    if (validation?.success === false) {
      const message = `The approved input is no longer valid for tool "${toolName}". Request a new tool call and approval.`;
      await input.publish(
        createActionResultEvent({
          ...at,
          result: toActionResult(
            createRuntimeToolResultFromValue({
              callId,
              isError: true,
              output: message,
              toolName,
            }),
            args,
          ),
        }),
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
    const decision: {
      readonly awaitsPerson?: true;
      readonly denied: boolean;
      readonly reason?: string;
    } =
      approval === "recheck"
        ? await recheckApprovedCall(definition, {
            abortSignal: input.abortSignal,
            callId,
            input: args,
            approvedTools: input.approvedTools,
          })
        : await decideApproval(definition, {
            abortSignal: input.abortSignal,
            callId,
            input: args,
            approvedTools: input.approvedTools,
          });
    if (decision.awaitsPerson === true) return { awaitsApproval: true, settled, toolResults };
    if (decision.denied) {
      const denial = await publishDenial(
        { callId, input: args, toolName },
        { approval, position: at, publish: input.publish, reason: decision.reason },
      );
      return { settled: [...settled, ...denial.settled], toolResults };
    }
    let output: unknown;
    let failed = false;
    let failure = "";
    const telemetry = toolTelemetry(input.telemetry, {
      // A call a person approved runs outside any model call.
      callId: input.modelCallId ?? `approved:${callId}`,
      messages: [...input.messages],
      toolCall: { input: args, toolCallId: callId, toolName, type: "tool-call" },
    });
    await telemetry.started();
    let executionMs = 0;
    try {
      await telemetry.execute(async () => {
        const startedAt = performance.now();
        try {
          input.beforeExecute?.();
          started = true;
          const executed = invokeTool(definition, args, {
            abortSignal: input.abortSignal,
            messages: [...input.messages],
            toolCallId: callId,
          });
          // A model's call is abandoned when its step is cut, as the AI SDK did: the step stops
          // waiting, and whatever the tool returns later is dropped.
          const abandon = approval === "evaluate" ? input.abortSignal : undefined;
          if (isAsyncIterable(executed)) {
            for await (const partial of untilAborted(executed, abandon)) {
              output = partial;
              const visible = withoutSignInSecrets(partial);
              await input.publish(
                createActionPartialEvent({
                  ...at,
                  presentation: projectDeltaPresentation(
                    definition,
                    callId,
                    parseJsonObject(args),
                    visible,
                  ),
                  result: createRuntimeToolResultFromValue({
                    callId,
                    output: visible,
                    toolName,
                  }),
                }),
              );
            }
          } else {
            output = await raceAbort(Promise.resolve(executed), abandon);
          }
        } finally {
          executionMs = performance.now() - startedAt;
        }
      });
    } catch (error) {
      await telemetry.ended(
        { error, input: args, toolCallId: callId, toolName, type: "tool-error" },
        executionMs,
      );
      throwIfTurnAborted(input.abortSignal);
      logError(log, "tool execution failed", error, { toolName, toolCallId: callId });
      failed = true;
      output = toError(error).message;
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
      return { settled, signIn: { callId, signal: output }, toolResults };
    }
    toolResults.push({
      input: args,
      output,
      toolCallId: callId,
      toolName,
      type: "tool-result",
    } as TypedToolResult<ToolSet>);
    completed = {
      part: {
        output: failed
          ? { type: "error-text", value: failure }
          : await toolCallModelOutput(definition, output, callId),
        toolCallId: callId,
        toolName,
        type: "tool-result",
      },
    };
    settled.push(completed);
    await input.publish(
      createActionResultEvent({
        ...at,
        presentation: failed
          ? undefined
          : projectResultPresentation(definition, callId, parseJsonObject(args), output),
        result: toActionResult(
          createRuntimeToolResultFromValue({ callId, isError: failed, output, toolName }),
          args,
        ),
      }),
    );
    return { settled, toolResults };
  } catch (error) {
    if (input.abortSignal?.aborted === true) {
      if (!started) throwIfTurnAborted(input.abortSignal);
      if (completed !== undefined) return { settled: [completed], toolResults };
      return { settled: [interruptedResult(callId, toolName)], toolResults };
    }
    const message = toError(error).message;
    logError(log, "tool call failed", error, { toolName, toolCallId: callId });
    await input.publish(
      createActionResultEvent({
        ...at,
        result: toActionResult(
          createRuntimeToolResultFromValue({
            callId,
            isError: true,
            output: message,
            toolName,
          }),
          args,
        ),
      }),
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
}

/**
 * Rejects with the signal's reason once it aborts, without waiting for `promise`. An abandoned
 * call may still settle later; its outcome is dropped, not reported as unhandled.
 */
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
  while (true) {
    const next = await raceAbort(iterator.next(), signal);
    if (next.done === true) return;
    yield next.value;
  }
}

/**
 * What the model reads for a call whose tool threw: the error as the AI SDK rendered it, with its
 * name, which tells the model what kind of failure it was (a `TimeoutError` may be worth retrying).
 */
function modelFacingError(error: unknown): string {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.toString();
  return JSON.stringify(error);
}

/** A sign-in challenge as readers may see it: its URLs and codes stay with the session. */
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

/**
 * The telemetry around one tool execution, as the AI SDK dispatched it for a call it ran: each
 * integration hears the start and the end, and their `executeTool` wrappers nest around the call
 * so work it does is attributed to it. Integration failures don't fail the call.
 */
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
  const event = {
    ...execution,
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
          toolOutput,
        } as ToolExecutionEnd),
      ),
  };
}

/** What the local calls of one model response produced. */
export interface InlineCallResults {
  /** The calls' results, for the response's tool message. */
  readonly parts: readonly ToolResultPart[];
  /** What each call's `execute` returned, for `endsTurn`. */
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
  /** The calls that wait on a person's approval. */
  readonly approvals: readonly InputRequest[];
  /** The calls that stopped for a sign-in. */
  readonly signIns: readonly ToolSignIn[];
}

/** Nothing ran: the response ended early, or made no local calls. */
export const NO_INLINE_CALLS: InlineCallResults = {
  approvals: [],
  parts: [],
  signIns: [],
  toolResults: [],
};

/**
 * Runs the local calls a model response made. The AI SDK only calls the model: eve decides each
 * call's approval and runs it the way it runs a call a person approved. A call to a tool that runs
 * outside the step (a workflow or task tool) is decided here and left for the runtime.
 */
export async function executeInlineCalls(input: {
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
  /** Calls whose input failed validation; they already have their result. */
  readonly excludedCallIds: ReadonlySet<string>;
  /** The step's entries: each call already names the entry it runs. */
  readonly tools: HarnessToolLookup;
  readonly approvedTools: ReadonlySet<string>;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
  readonly position: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly publish: HandleEventFn;
  readonly abortSignal: AbortSignal | undefined;
  readonly telemetry?: TelemetryOptions;
  /** The AI SDK's ID for the model call that made the calls. */
  readonly modelCallId?: string;
  /** Runs just before each tool does, so steering no longer interrupts the step. */
  readonly beforeExecute: () => void;
}): Promise<InlineCallResults> {
  const calls = input.toolCalls.filter(
    (call) =>
      call.providerExecuted !== true &&
      !isInvalidToolCall(call) &&
      !input.excludedCallIds.has(call.toolCallId) &&
      input.tools.get(call.toolName) !== undefined,
  );
  const executed = await Promise.all(
    calls.map(async (call): Promise<{ call: TypedToolCall<ToolSet>; executed: CallOutcome }> => {
      const definition = input.tools.get(call.toolName)!;
      const action = { callId: call.toolCallId, input: call.input, toolName: call.toolName };
      if (isRunnableTool(definition)) {
        return {
          call,
          executed: await executeToolCall(action, { ...input, definition }, "evaluate"),
        };
      }
      return { call, executed: await decideDeferredCall(action, definition, input) };
    }),
  );
  return {
    approvals: executed.flatMap(({ call, executed }) =>
      executed.awaitsApproval === true
        ? [approvalRequest(call, input.tools.get(call.toolName))]
        : [],
    ),
    parts: executed.flatMap(({ executed }) => executed.settled.map((result) => result.part)),
    signIns: executed.flatMap(({ executed }) =>
      executed.signIn === undefined ? [] : [executed.signIn],
    ),
    toolResults: executed.flatMap(({ executed }) => executed.toolResults),
  };
}

/** A deferred call waits on a person or is denied here; otherwise the runtime runs it. */
async function decideDeferredCall(
  call: { readonly callId: string; readonly input: unknown; readonly toolName: string },
  definition: HarnessToolDefinition,
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly approvedTools: ReadonlySet<string>;
    readonly position: {
      readonly sequence: number;
      readonly stepIndex: number;
      readonly turnId: string;
    };
    readonly publish: HandleEventFn;
  },
): Promise<CallOutcome> {
  if (definition.approval === undefined) return { settled: [], toolResults: [] };
  const decision = await decideApproval(definition, {
    abortSignal: input.abortSignal,
    approvedTools: input.approvedTools,
    callId: call.callId,
    input: call.input,
  });
  if (decision.awaitsPerson === true) return { awaitsApproval: true, settled: [], toolResults: [] };
  if (!decision.denied) return { settled: [], toolResults: [] };
  return await publishDenial(call, {
    approval: "evaluate",
    position: input.position,
    publish: input.publish,
    reason: decision.reason,
  });
}

/**
 * Reports a call its approval policy refused, so it doesn't run. A refusal as the response ends
 * fails the call, as the AI SDK reported it; a refusal of a call a person approved rejects it.
 */
async function publishDenial(
  call: { readonly callId: string; readonly input: unknown; readonly toolName: string },
  input: {
    readonly approval: "evaluate" | "recheck";
    readonly position: {
      readonly sequence: number;
      readonly stepIndex: number;
      readonly turnId: string;
    };
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
    input.approval === "evaluate"
      ? createActionResultEvent({
          ...input.position,
          result: createRuntimeToolResultFromMessagePart(part, call.toolName),
        })
      : createActionResultEvent({
          ...input.position,
          rejected: true,
          result: {
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
        }),
  );
  return { settled: [{ part }], toolResults: [] };
}

/**
 * What a person answers to approve or cancel a call the model made. The prompt names the call by
 * the label its entry gives it.
 */
function approvalRequest(
  call: TypedToolCall<ToolSet>,
  definition: HarnessToolDefinition | undefined,
): InputRequest {
  const action = createRuntimeToolCallActionFromToolCall({ toolCall: call });
  const label = projectToolStartLabel(definition, action.input) ?? displayTitle(action.toolName);
  return {
    action,
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Approve ${label}?`,
    requestId: generateId(),
  };
}
