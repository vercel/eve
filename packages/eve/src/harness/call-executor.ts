import type { ApprovalMemory, RememberRequest } from "#approval/evaluation.js";
import {
  identityRequestOf,
  rememberedConfirmations,
  withCallIdentity,
  type IdentityRequest,
} from "#runtime/connections/caller-confirmation.js";
import type { SessionAuthContext } from "#channel/types.js";
import { personAuth, principalOf, type SessionPerson } from "#context/session-auth.js";
import { delegatedMessages, sessionParticipants, turnMessages } from "#harness/sender-line.js";
import type { JsonObject } from "#shared/json.js";
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
import { callProgress } from "#harness/call-facts.js";
import { settleCall, startCall } from "#harness/session-machine/calls.js";
import { withUsageCall } from "#harness/usage-sink.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import { toModelSchema } from "#tools/schema.js";
import { projectToolLabel } from "#harness/action-presentation.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";
import { liveProjection } from "#harness/session-machine/current.js";
import type { Principal } from "#protocol/session-events/envelope.js";

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
  /** What cleared a call the runtime runs outside the step, such as a workflow tool's. */
  readonly clearance?: Clearance;
  readonly settled: readonly CallResult[];
  /** What `execute` returned, for `endsTurn`. */
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
  readonly awaitsApproval?: true;
  readonly signIn?: ToolSignIn;
  /** The call stopped for a person's identity: what eve asks them. */
  readonly identity?: ApprovalAsk;
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
    /** The session as the call resumes, where a person's acceptance clears a call they approved. */
    readonly view?: () => Pick<SessionView, "projection">;
    /** Who approved the call, which it reads as `ctx.approval`; it still runs as the requester. */
    readonly responder?: SessionAuthContext;
    /**
     * The people who approved the call, whose identities it may use whoever spoke last: the caller
     * for their approval of the call itself, and whoever approved eve's requests for their
     * identity. A later request keeps them all.
     */
    readonly confirmedBy?: readonly SessionPerson[];
    /**
     * The session can ask a person: a call refused for someone's identity stops and asks them
     * instead of failing.
     */
    readonly canAsk?: boolean;
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
      return { awaitsApproval: true, remember: decision.remember, settled, toolResults };
    if (decision.denied) {
      await input.beforeResult?.(decision.reason ?? TOOL_EXECUTION_DENIED_MESSAGE);
      const denial = await publishDenial(
        { callId, input: args, toolName },
        { publish: input.publish, reason: decision.reason },
      );
      return { settled: [...settled, ...denial.settled], toolResults };
    }
    // A call a person approved runs on their acceptance; the recheck only confirms it still may.
    const clearance =
      (approval === "recheck" && input.view !== undefined
        ? approvedClearance(input.view().projection.view, callId)
        : undefined) ?? decision.clearance;
    if (clearance === undefined) throw new Error(`Call "${callId}" has no clearance to run.`);
    let output: unknown;
    let failed = false;
    let failure = "";
    let thrown: Error | undefined;
    let identity: IdentityRequest | undefined;
    const confirmed = input.confirmedBy ?? [];
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
          await input.publish(startCall(clearance));
          // Usage the tool records belongs to its call, including while a streaming tool iterates,
          // and so do the identities of the people who approved the call, and the caller's
          // remembered `callerConfirmation: "once"` approvals.
          const identityScope = {
            canAsk: input.canAsk === true,
            confirmed,
            remembered: rememberedConfirmations(input.approvalMemory?.remembered),
          };
          await withCallIdentity(identityScope, () =>
            withUsageCall(callId, async () => {
              const executed = invokeTool(
                definition,
                args,
                {
                  ...(input.responder !== undefined && {
                    approval: { responder: input.responder },
                  }),
                  abortSignal: input.abortSignal,
                  messages: [...input.messages],
                  toolCallId: callId,
                },
                clearance,
              );
              // A model's call is abandoned when its step is cut, as the AI SDK did: the step stops
              // waiting, and whatever the tool returns later is dropped.
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
            }),
          );
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
      identity = input.canAsk === true ? identityRequestOf(error) : undefined;
      if (identity === undefined)
        logError(log, "tool execution failed", error, { toolName, toolCallId: callId });
      failed = true;
      thrown = toError(error);
      output = thrown.message;
      failure = modelFacingError(error);
    }
    // A refusal for someone's identity asks them where the session can, as a sign-in does: the
    // call stops without a result, and runs again from the top once they approve.
    if (identity !== undefined) {
      return {
        identity: identityApprovalRequest(
          { callId, input: args, toolName, version: definition.version },
          identity,
          { confirmed, responder: input.responder },
        ),
        settled,
        toolResults,
      };
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
    if (input.abortSignal?.aborted === true) {
      if (!started) throwIfTurnAborted(input.abortSignal);
      if (completed !== undefined) return { settled: [completed], toolResults };
      return { settled: [interruptedResult(callId, toolName)], toolResults };
    }
    const failure = toError(error);
    logError(log, "tool call failed", error, { toolName, toolCallId: callId });
    await input.beforeResult?.(failure);
    const failed = failedCall({ callId, toolName, message: failure });
    await input.publish(settleCall(failed.result));
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
  readonly policyApprovals?: Readonly<Record<string, Clearance>>;
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
  /** The session can ask a person, so a call refused for someone's identity asks them. */
  readonly canAsk?: boolean;
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
              : executed.identity;
          return { call, executed, approval };
        } catch (error) {
          throwIfTurnAborted(input.abortSignal);
          const failed = failedCall({ ...action, message: toError(error) });
          await input.publish(settleCall(failed.result));
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
        executed.clearance === undefined ? [] : [[call.toolCallId, executed.clearance]],
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
      clearance: decision.clearance,
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

/**
 * How much of the latest message, and of the call's input, an identity request shows, counted as
 * shown, after escaping. Each input field, and each item inside one, is cut on its own, so a long
 * early value can't hide a later one.
 */
const QUOTE_LIMIT = 280;
const FIELD_LIMIT = 2_000;
const MIN_FIELD_LIMIT = 80;
const MIN_ITEM_LIMIT = 40;
const KEY_LIMIT = 80;
const INPUT_LIMIT = 8_000;
const HIDDEN_NAMES_LIMIT = 5;

/**
 * What eve asks a person whose identity a call needs: what is asked and of whom, what a
 * remembered approval lets someone else do, the latest message in the turn from someone else,
 * which they approve along with the call, and then the input the call runs with. The short parts
 * come first, so a channel that cuts a long prompt still shows them. Nothing the model wrote
 * names the call. Only the person can approve it; anyone
 * signed in can cancel it.
 */
function identityApprovalRequest(
  call: {
    readonly callId: string;
    readonly input: unknown;
    readonly toolName: string;
    readonly version?: string;
  },
  identity: IdentityRequest,
  context: {
    readonly confirmed: readonly SessionPerson[];
    readonly responder: SessionAuthContext | undefined;
  },
): ApprovalAsk {
  const { callId, toolName } = call;
  const input = resolveToolCallInputObject(call.input, { callId, toolName });
  const latest = latestMessageFromOthers(identity.person);
  // JSON keeps the quoted text inside its own quotes, so it can't pass for eve's words.
  const quote =
    latest === undefined
      ? ""
      : ` The latest message from someone else, from ${latest.from}, reads: ${JSON.stringify(truncate(latest.text, QUOTE_LIMIT))}.`;
  // Under `callerConfirmation: "once"`, the approval is remembered for the person who spoke last.
  const remembered =
    identity.steeredBy === undefined
      ? ""
      : ` Approving also lets ${identity.steeredBy} steer calls that use your identity for the rest of this conversation.`;
  const { confirmed, responder } = context;
  return {
    call: {
      callId,
      input,
      toolName,
      ...(call.version !== undefined && { version: call.version }),
    },
    identity: {
      person: identity.person,
      ...(responder !== undefined && { responder }),
      ...(confirmed.length > 0 && { confirmed }),
    },
    interactionId: generateId(),
    ...(identity.remember !== undefined && { remember: identity.remember }),
    request: {
      allowFreeform: false,
      display: "confirmation",
      kind: "approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Cancel" },
      ],
      prompt: `Approve ${displayTitle(toolName)} with your identity?${remembered}${quote} It runs with ${describeInput(input)}.`,
    },
  };
}

/**
 * The text of the latest message the turn read from someone other than `person`, and who sent it,
 * from the deliveries the turn consumed that name their sender.
 */
function latestMessageFromOthers(
  person: SessionPerson,
): { readonly from: string; readonly text: string } | undefined {
  const projection = liveProjection();
  if (projection === undefined) return undefined;
  // A delivery names its sender without how they signed in, so eve compares the people who have
  // spoken by `principalOf`: a delivery is the person's only when no one else who has spoken
  // could have sent it.
  const key = principalOf(personAuth(person));
  const others = (sessionParticipants() ?? []).filter(
    (other) => principalOf(personAuth(other)) !== key,
  );
  const sentBy = (principal: Principal) =>
    names(principal, person) && !others.some((other) => names(principal, other));
  // A local child's own messages come from the agent that delegated to it, so the messages its
  // parent's turn read count too, before the child's own.
  const latest = [...(delegatedMessages() ?? []), ...turnMessages(projection)]
    .filter((message) => !sentBy(message.from))
    .at(-1);
  return latest === undefined ? undefined : { from: latest.from.id, text: latest.text };
}

/** Whether a delivery's principal names `person`, as far as the wire tells. */
function names(principal: Principal, person: SessionPerson): boolean {
  return (
    principal.id === person.principalId &&
    principal.type === person.principalType &&
    (principal.issuer ?? null) === (person.issuer ?? null)
  );
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ");
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The call's input as an identity request shows it: every top-level field, each cut on its own
 * with a marker that says how much is hidden. Fields past the overall limit are named.
 */
function describeInput(input: JsonObject): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "no input";
  const limit = Math.min(
    FIELD_LIMIT,
    Math.max(MIN_FIELD_LIMIT, Math.floor(INPUT_LIMIT / entries.length)),
  );
  return describeEntries(entries, limit, INPUT_LIMIT, "fields");
}

/**
 * `key: value` pairs, each value cut at `limit` shown characters, until `total` is spent. The rest
 * are counted, and the first few named.
 */
function describeEntries(
  entries: readonly (readonly [string | undefined, unknown])[],
  limit: number,
  total: number,
  noun: "fields" | "items",
): string {
  const shown: string[] = [];
  let length = 0;
  for (const [index, [name, value]] of entries.entries()) {
    const key = name === undefined ? "" : `${encodeText(name, KEY_LIMIT)}: `;
    const entry = `${key}${describeValue(value, limit)}`;
    if (shown.length > 0 && length + entry.length > total) {
      const rest = entries.slice(index).flatMap(([other]) => (other === undefined ? [] : [other]));
      const named = rest.slice(0, HIDDEN_NAMES_LIMIT).map((other) => encodeText(other, KEY_LIMIT));
      const more =
        rest.length > named.length ? `, and ${String(rest.length - named.length)} more` : "";
      const names = named.length === 0 ? "" : ` (${named.join(", ")}${more})`;
      shown.push(`and ${String(entries.length - index)} more ${noun} not shown${names}`);
      break;
    }
    shown.push(entry);
    length += entry.length;
  }
  return shown.join(", ");
}

/**
 * One input value as JSON, at most about `limit` characters as shown. A string is cut after
 * escaping; an array or object shares `limit` among its items, so a later item stays visible.
 */
function describeValue(value: unknown, limit: number): string {
  if (typeof value === "string") return encodeText(value, limit);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const isArray = Array.isArray(value);
  const entries: (readonly [string | undefined, unknown])[] = isArray
    ? value.map((item: unknown) => [undefined, item] as const)
    : Object.entries(value);
  if (entries.length === 0) return isArray ? "[]" : "{}";
  const share = Math.max(MIN_ITEM_LIMIT, Math.floor(limit / entries.length));
  const inner = describeEntries(entries, share, limit, "items");
  return isArray ? `[${inner}]` : `{${inner}}`;
}

/**
 * `text` as a JSON string, cut once its escaped form reaches `limit` characters, with a marker
 * outside the quotes that says how many characters are hidden.
 */
function encodeText(text: string, limit: number): string {
  const encoded = JSON.stringify(text);
  if (encoded.length <= limit) return encoded;
  let head = "";
  let length = 2;
  let used = 0;
  for (const character of text) {
    const escaped = JSON.stringify(character).slice(1, -1);
    if (length + escaped.length > limit) break;
    head += escaped;
    length += escaped.length;
    used += character.length;
  }
  return `"${head}"… (${String(text.length - used)} more characters not shown)`;
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
