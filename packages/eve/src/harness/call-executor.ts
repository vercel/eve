import type { ApprovalMemory, RememberRequest } from "#approval/evaluation.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ClearedBy } from "#protocol/session-events/families/call.js";
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
import type { HandleEventFn, HarnessToolLookup } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { callProgress, callSettledFrom, callStarted } from "#harness/call-facts.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import { toModelSchema } from "#tools/schema.js";
import { projectToolLabel } from "#harness/action-presentation.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";

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
  readonly input: unknown;
  readonly toolName: string;
  readonly signal: AuthorizationSignal;
  readonly version?: string;
}

/** How one call came out: its result for the model, or what it waits on instead. */
export interface CallOutcome {
  readonly remember?: RememberRequest;
  readonly clearedBy?: ClearedBy;
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
    readonly approvalMemory?: ApprovalMemory;
    readonly definition: RunnableTool;
    readonly messages: readonly ModelMessage[];
    readonly publish: HandleEventFn;
    readonly telemetry?: TelemetryOptions;
    /** The AI SDK's ID for the model call that made a fresh call. */
    readonly modelCallId?: string;
    /** Runs just before the tool does, as the step's steering protection. */
    readonly beforeExecute?: () => void;
    /** What cleared a call a person approved: the interaction that asked them. */
    readonly clearedBy?: ClearedBy;
    /** Who approved the call, which it reads as `ctx.approval`; it still runs as the requester. */
    readonly responder?: SessionAuthContext;
    /**
     * Runs once the call settles, just before its result is reported: with why it didn't succeed,
     * if it didn't. Not when it stops for a sign-in or the turn's cancellation cuts it short.
     */
    readonly beforeResult?: (failure?: Error | string) => Promise<void>;
  },
  approval: CallApproval,
): Promise<CallOutcome> {
  const { callId, toolName, input: args } = call;
  const { definition } = input;
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
      await input.beforeResult?.(message);
      await input.publish(
        callSettledFrom(
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
      return { awaitsApproval: true, remember: decision.remember, settled, toolResults };
    if (decision.denied) {
      await input.beforeResult?.(decision.reason ?? TOOL_EXECUTION_DENIED_MESSAGE);
      const denial = await publishDenial(
        { callId, input: args, toolName },
        { publish: input.publish, reason: decision.reason },
      );
      return { settled: [...settled, ...denial.settled], toolResults };
    }
    const clearedBy = input.clearedBy ?? decision.clearedBy;
    let output: unknown;
    let failed = false;
    let failure = "";
    let thrown: Error | undefined;
    const telemetry = toolTelemetry(input.telemetry, {
      // A call a person approved runs outside any model call.
      callId: input.modelCallId ?? `approved:${callId}`,
      messages: [...input.messages],
      toolCall: { input: args, toolCallId: callId, toolName, type: "tool-call" },
    });
    input.beforeExecute?.();
    await telemetry.started();
    let executionMs = 0;
    try {
      await telemetry.execute(async () => {
        const startedAt = performance.now();
        try {
          started = true;
          // A call a person approved starts when it runs, after the recheck: the approval cleared
          // it, and the policy could still have refused it.
          await input.publish(callStarted(callId, clearedBy === undefined ? {} : { clearedBy }));
          const executed = invokeTool(definition, args, {
            ...(input.responder !== undefined && { approval: { responder: input.responder } }),
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
                callProgress(callId, visible, projectToolLabel(definition, "delta", args, visible)),
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
    await input.beforeResult?.(failed ? thrown : undefined);
    await input.publish(
      callSettledFrom(
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
    if (input.abortSignal?.aborted === true) {
      if (!started) throwIfTurnAborted(input.abortSignal);
      if (completed !== undefined) return { settled: [completed], toolResults };
      return { settled: [interruptedResult(callId, toolName)], toolResults };
    }
    const failure = toError(error);
    logError(log, "tool call failed", error, { toolName, toolCallId: callId });
    await input.beforeResult?.(failure);
    const failed = failedCall({ callId, toolName, message: failure });
    await input.publish(callSettledFrom(failed.result));
    return { settled: [{ part: failed.part }], toolResults };
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
    // Request cleanup without letting an uncooperative iterator hold up cancellation.
    if (!done && iterator.return !== undefined)
      await raceAbort(Promise.resolve(iterator.return()), signal);
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
  readonly approvals: readonly ApprovalAsk[];
  /** The calls that stopped for a sign-in. */
  readonly signIns: readonly ToolSignIn[];
  readonly policyApprovals?: Readonly<Record<string, ClearedBy>>;
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
  readonly approvalMemory: ApprovalMemory;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
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
  const finished = await Promise.allSettled(
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
              ? { ...approvalRequest(call, definition), remember: executed.remember }
              : undefined;
          return { call, executed, approval };
        } catch (error) {
          throwIfTurnAborted(input.abortSignal);
          const failed = failedCall({ ...action, message: toError(error) });
          await input.publish(callSettledFrom(failed.result));
          return { call, executed: { settled: [{ part: failed.part }], toolResults: [] } };
        }
      },
    ),
  );
  const rejected = finished.find((call) => call.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  const executed = finished.flatMap((call) => (call.status === "fulfilled" ? [call.value] : []));
  return {
    policyApprovals: Object.fromEntries(
      executed.flatMap(({ call, executed }) =>
        executed.clearedBy === undefined ? [] : [[call.toolCallId, executed.clearedBy]],
      ),
    ),
    approvals: executed.flatMap(({ approval }) => (approval === undefined ? [] : [approval])),
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
    readonly approvalMemory: ApprovalMemory;
    readonly publish: HandleEventFn;
  },
): Promise<CallOutcome> {
  if (definition.approval === undefined) return { settled: [], toolResults: [] };
  const decision = await decideApproval(definition, {
    abortSignal: input.abortSignal,
    approvalMemory: input.approvalMemory,
    callId: call.callId,
    input: call.input,
  });
  if (decision.awaitsPerson === true)
    return { awaitsApproval: true, remember: decision.remember, settled: [], toolResults: [] };
  if (!decision.denied)
    return {
      settled: [],
      toolResults: [],
      clearedBy: decision.clearedBy,
    };
  return await publishDenial(call, {
    publish: input.publish,
    reason: decision.reason,
  });
}

/** Reports a call its approval policy refused: it settles rejected, without running. */
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
    callSettledFrom(
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

/**
 * What a person answers to approve or cancel a call the model made. The prompt is the one the
 * tool's approval writes for the call, or names the call by the label its entry gives it.
 */
function approvalRequest(
  call: TypedToolCall<ToolSet>,
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

/** The prompt a tool's approval configuration writes for `call`, when it has one. */
function authoredApprovalPrompt(
  call: TypedToolCall<ToolSet>,
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
