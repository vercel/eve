/**
 * The child side of a task: a delegated session tells its owner it started,
 * and answers the caller of each turn with that turn's settled result, over
 * the caller's hook or, for a remote owner, its HTTP callback.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import type { TaskStartedHookPayload, TurnCaller } from "#channel/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import {
  reportedAnswer,
  reportedSteers,
  reportOrdering,
  TASK_PROTOCOL_VERSION,
  type ChildTaskReport,
} from "#tasks/protocol.js";
import { isTaskProtocolRefusal } from "#subagents/remote/protocol.js";
import { recordTaskReport } from "#subagents/remote/task-reports.js";
import { ActivityObserverKey, SessionCallbackKey } from "#context/keys.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
  type SubagentAdapterState,
} from "#subagents/adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import { AGENT_CALL_CANCELLED_MESSAGE } from "#tasks/render.js";
import { createLogger } from "#internal/logging.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const log = createLogger("execution.delegated-parent-notification");

/** Settled turn payload forwarded from the owner to the caller. */
export interface SettledTurnNotification {
  readonly output: unknown;
  readonly isError?: boolean;
  /** Task error code for a failed settlement; defaults to the generic execution failure. */
  readonly errorCode?: string;
  /** Usage accumulated since the previous caller settlement, including yielded turns. */
  readonly usage?: TokenUsage;
  /** Steering messages for the call that the session received since it last answered it. */
  readonly steers?: number;
  /** The answer's place among this session's answers; see `answerOrder`. */
  readonly answer?: number;
}

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Sends a settled conversation turn to the caller that started it.
 *
 * `lifecycle` is the child engine's explicit verdict — `parked` when the
 * child session survived the turn and can accept another delivery,
 * `terminal` when it ended with this turn. It is carried on the result as
 * an {@link AgentTurnOutcome} so the caller never infers lifecycle from
 * success or error codes.
 */
export async function notifyTurnCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): Promise<void> {
  "use step";

  if (input.caller === undefined) {
    return;
  }

  const result = createSettledTurnResult({
    caller: input.caller,
    lifecycle: input.lifecycle,
    sessionId: input.sessionId,
    settled: input.settled,
  });

  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: input.sessionId,
      token: input.caller.replyTo.token,
      url: input.caller.replyTo.url,
    });
    return;
  }

  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

/** Settles a workflow-owned caller after the child turn is cooperatively cancelled. */
export async function notifyCancelledTaskCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly sessionId: string;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.caller === undefined) return;
  const usageDelta = input.usage ?? ZERO_TOKEN_USAGE;
  const base: RuntimeSubagentChildResult = {
    callId: input.caller.callId,
    isError: true,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: "parked",
      result: { kind: "cancelled" },
      usageDelta,
    },
    output: AGENT_CALL_CANCELLED_MESSAGE,
    subagentName: input.caller.subagentName,
  };
  const result = input.usage === undefined ? base : { ...base, usage: input.usage };
  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: input.sessionId,
      token: input.caller.replyTo.token,
      url: input.caller.replyTo.url,
    });
    return;
  }
  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

/**
 * Reports a caller settlement the session refused because tasks its turn
 * started were still working: a reply must follow its turn's tasks, so this
 * is a bug in the turn rule, not a state the caller can recover from. Tests
 * and development fail the run so the bug surfaces; production logs it and
 * leaves the caller unsettled.
 */
export async function reportRefusedCallerReplyStep(input: {
  readonly callId: string;
  readonly sessionId: string;
  readonly taskIds: readonly string[];
}): Promise<void> {
  "use step";

  log.error("refused to settle a delegated caller while its turn has working tasks", {
    callId: input.callId,
    sessionId: input.sessionId,
    taskIds: [...input.taskIds],
  });
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    throw new Error(
      `Refused to settle caller ${input.callId} of session ${input.sessionId} while tasks ${input.taskIds.join(", ")} are working.`,
    );
  }
}

function createSettledTurnResult(input: {
  readonly caller: TurnCaller;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): ChildTaskReport {
  const usageDelta = input.settled.usage ?? ZERO_TOKEN_USAGE;
  const steers = reportOrdering(input.settled.steers, input.settled.answer);

  if (input.settled.isError === true) {
    const error = {
      code: input.settled.errorCode ?? EXECUTION_FAILED,
      message: toErrorMessage(input.settled.output),
    };
    return {
      callId: input.caller.callId,
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: input.lifecycle,
        result: { error, kind: "failed" },
        usageDelta,
      },
      output: error,
      subagentName: input.caller.subagentName,
      ...steers,
    };
  }

  const output = parseJsonValue(input.settled.output);
  const result: ChildTaskReport = {
    callId: input.caller.callId,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: input.lifecycle,
      result: { kind: "succeeded", output },
      usageDelta,
    },
    output,
    subagentName: input.caller.subagentName,
    ...steers,
  };
  // Legacy per-result usage projection (usage spans); the parent folds
  // `outcome.usageDelta`, never this field, when an outcome is present.
  return input.settled.usage === undefined ? result : { ...result, usage: input.settled.usage };
}

/**
 * Resolves the caller that created this delegated session and, for a local
 * owner, tells it in the same step that this child claimed its addresses and
 * can be reached, so the report adds no step before the child's first turn.
 * `ownerGone` means the owner no longer exists: the child exits instead of
 * doing work nobody will receive. It runs only after the child's claims made
 * this run the only one.
 */
export async function reportTaskStartedStep(input: {
  readonly child: TaskStartedHookPayload["child"];
  readonly serializedContext: Record<string, unknown>;
}): Promise<{ readonly caller: TurnCaller | undefined; readonly ownerGone: boolean }> {
  "use step";

  const caller = await resolveInitialTurnCaller(input.serializedContext);
  if (caller?.replyTo.kind !== "hook") return { caller, ownerGone: false };
  const payload: TaskStartedHookPayload = {
    callId: caller.callId,
    child: input.child,
    kind: "task.started",
  };
  try {
    await resumeHook(caller.replyTo.token, payload);
    return { caller, ownerGone: false };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    log.warn("task owner no longer exists; the child exits", { callId: caller.callId });
    return { caller, ownerGone: true };
  }
}

/** Resolves the caller that created a delegated conversation session. */
export async function resolveInitialTurnCallerStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<TurnCaller | undefined> {
  "use step";

  return await resolveInitialTurnCaller(input.serializedContext);
}

async function resolveInitialTurnCaller(
  serializedContext: Record<string, unknown>,
): Promise<TurnCaller | undefined> {
  const callbackValue = serializedContext[SessionCallbackKey.name];
  if (callbackValue !== undefined) {
    const parsed = parseSessionCallback(callbackValue);
    if (!parsed.ok) {
      throw new Error("Serialized session callback is invalid.", {
        cause: parsed.cause,
      });
    }
    return {
      callId: parsed.callback.callId,
      replyTo: {
        kind: "callback",
        token: parsed.callback.token,
        url: parsed.callback.url,
      },
      subagentName: parsed.callback.subagentName,
    };
  }

  const ctx = await deserializeContext(serializedContext);
  const adapter = ctx.get(ChannelKey);
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return undefined;
  }

  return {
    callId: adapter.state.callId,
    replyTo: { kind: "hook", token: adapter.state.parentContinuationToken },
    subagentName: adapter.state.subagentName,
  };
}

/** Rebinds child event forwarding to the caller that owns the next accepted turn. */
export async function bindTurnCallerContextStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const caller = input.caller;
  if (caller === undefined) return input.serializedContext;
  const withActivity =
    caller.activityObserver === undefined
      ? input.serializedContext
      : { ...input.serializedContext, [ActivityObserverKey.name]: caller.activityObserver };
  if (caller.replyTo.kind === "callback") {
    const callback = {
      callId: caller.callId,
      subagentName: caller.subagentName,
      token: caller.replyTo.token,
      url: caller.replyTo.url,
    };
    return { ...withActivity, [SessionCallbackKey.name]: callback };
  }

  const adapter = withActivity[ChannelKey.name];
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    Reflect.get(adapter, "kind") !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(Reflect.get(adapter, "state"))
  ) {
    throw new Error("Delegated local turn is missing its subagent adapter binding.");
  }
  const state = Reflect.get(adapter, "state") as SubagentAdapterState;
  const nextState: Record<string, unknown> = {
    ...state,
    callId: caller.callId,
    parentContinuationToken: caller.replyTo.token,
    subagentName: caller.subagentName,
  };
  return {
    ...withActivity,
    [ChannelKey.name]: {
      ...adapter,
      state: nextState,
    },
  };
}

/**
 * Posts a settled turn to a remote caller. The report is recorded first, so
 * a caller whose callback is lost can still read it at its deadline.
 */
async function postSettledTurnCallback(input: {
  readonly result: RuntimeSubagentChildResult;
  /** Narrows which remote task the report may settle; it is also the report's store. */
  readonly sessionId: string;
  /** The caller's callback token; only its holder may read the recorded report. */
  readonly token: string;
  readonly url: string;
}): Promise<void> {
  const { result, sessionId } = input;
  const common = {
    answer: reportedAnswer(result),
    callId: result.callId,
    sessionId,
    steers: reportedSteers(result),
    subagentName: result.subagentName,
    taskProtocol: TASK_PROTOCOL_VERSION,
  };
  const payload =
    result.isError === true
      ? { ...common, error: result.output, kind: "turn.failed", outcome: result.outcome }
      : { ...common, kind: "turn.completed", outcome: result.outcome, output: result.output };
  await recordTaskReport({ callbackToken: input.token, report: payload, sessionId });
  await postCallbackPayload({ payload, url: input.url });
}

async function postCallbackPayload(input: {
  readonly payload: { readonly callId: string; readonly subagentName: string };
  readonly url: string;
}): Promise<void> {
  const response = await postSessionCallbackRequest({
    body: input.payload,
    url: input.url,
  });
  if (response.ok) return;
  if (await isTaskProtocolRefusal(response)) {
    // Retrying cannot change the caller's version; its deadline ends the call.
    log.error("turn caller refused the result for its task protocol version", {
      callId: input.payload.callId,
      subagentName: input.payload.subagentName,
    });
    return;
  }
  throw new Error(`Turn callback failed with HTTP ${response.status}.`);
}

async function resumeSettledTurnHook(
  token: string,
  result: RuntimeSubagentChildResult,
): Promise<void> {
  try {
    await resumeHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch (error) {
    if (!HookNotFoundError.is(error)) {
      throw error;
    }

    log.warn("turn caller hook no longer exists", {
      callId: result.callId,
      callerToken: token,
    });
  }
}
