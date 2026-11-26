import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import type { TurnCaller } from "#channel/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { SessionCallbackKey } from "#context/keys.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
  type SubagentAdapterState,
} from "#subagents/adapter-state.js";
import { resolveLocalInitialTurnCaller } from "#subagents/initial-caller.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { createLogger } from "#internal/logging.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import {
  REMOTE_CALLBACK_NOT_PENDING,
  REMOTE_CALLBACK_NOT_PENDING_MESSAGE,
} from "#protocol/remote-agent-protocol.js";

const log = createLogger("execution.delegated-parent-notification");

const SUBAGENT_EXECUTION_FAILED = "SUBAGENT_EXECUTION_FAILED";

export interface SettledTurnNotification {
  readonly output: unknown;
  readonly isError?: boolean;
  readonly usage?: TokenUsage;
}

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export async function notifyTurnCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
  readonly totalUsage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.caller === undefined) {
    return;
  }

  if (input.caller.directTask !== undefined && input.caller.replyTo.kind === "hook") {
    const usage = input.totalUsage ?? input.settled.usage;
    const message = directTaskTurnMessage({
      caller: input.caller,
      directTask: input.caller.directTask,
      lifecycle: input.lifecycle,
      sessionId: input.sessionId,
      settled: input.settled,
      usage,
    });
    await resumeDirectTaskHook(input.caller.replyTo.token, message, input.caller.callId);
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
      url: input.caller.replyTo.url,
    });
    return;
  }

  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

export async function notifyCancelledTaskCallerStep(input: {
  readonly caller: TurnCaller;
  readonly lifecycle?: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly totalUsage?: TokenUsage;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.caller.directTask !== undefined && input.caller.replyTo.kind === "hook") {
    const usage = input.totalUsage ?? input.usage;
    const message = directTaskCancelledMessage({
      caller: input.caller,
      directTask: input.caller.directTask,
      lifecycle: input.lifecycle,
      sessionId: input.sessionId,
      usage,
    });
    if (message !== undefined) {
      await resumeDirectTaskHook(input.caller.replyTo.token, message, input.caller.callId);
    }
    return;
  }

  const usageDelta = input.usage ?? ZERO_TOKEN_USAGE;
  const error = {
    code: SUBAGENT_EXECUTION_FAILED,
    message: "The agent invocation was cancelled.",
  };
  const base: RuntimeSubagentChildResult = {
    callId: input.caller.callId,
    isError: true,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: input.lifecycle ?? "parked",
      result: { kind: "cancelled" },
      usageDelta,
    },
    output: error,
    subagentName: input.caller.subagentName,
  };
  const result = input.usage === undefined ? base : { ...base, usage: input.usage };
  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: input.sessionId,
      url: input.caller.replyTo.url,
    });
    return;
  }
  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

function createSettledTurnResult(input: {
  readonly caller: TurnCaller;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): RuntimeSubagentChildResult {
  const usageDelta = input.settled.usage ?? ZERO_TOKEN_USAGE;

  if (input.settled.isError === true) {
    const error = {
      code: SUBAGENT_EXECUTION_FAILED,
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
    };
  }

  const output = parseJsonValue(input.settled.output);
  const result: RuntimeSubagentChildResult = {
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
  };
  return input.settled.usage === undefined ? result : { ...result, usage: input.settled.usage };
}

export async function resolveInitialTurnCallerStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<TurnCaller | undefined> {
  "use step";

  const callbackValue = input.serializedContext[SessionCallbackKey.name];
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

  return resolveLocalInitialTurnCaller(input.serializedContext);
}

export function bindTurnCallerContext(
  caller: TurnCaller | undefined,
  serializedContext: Record<string, unknown>,
): Record<string, unknown> {
  if (caller === undefined) return serializedContext;
  if (caller.replyTo.kind === "callback") {
    const callback = {
      callId: caller.callId,
      subagentName: caller.subagentName,
      token: caller.replyTo.token,
      url: caller.replyTo.url,
    };
    return { ...serializedContext, [SessionCallbackKey.name]: callback };
  }

  const adapter = serializedContext[ChannelKey.name];
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    Reflect.get(adapter, "kind") !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(Reflect.get(adapter, "state"))
  ) {
    throw new Error("Delegated local turn is missing its subagent adapter binding.");
  }
  const state = Reflect.get(adapter, "state") as SubagentAdapterState;
  const nextState: SubagentAdapterState = {
    ...state,
    callId: caller.callId,
    ...(caller.directTask !== undefined && { directTask: caller.directTask }),
    parentContinuationToken: caller.replyTo.token,
    subagentName: caller.subagentName,
  };
  return {
    ...serializedContext,
    [ChannelKey.name]: {
      ...adapter,
      state: nextState,
    },
  };
}

async function postSettledTurnCallback(input: {
  readonly result: RuntimeSubagentChildResult;
  readonly sessionId: string;
  readonly url: string;
}): Promise<void> {
  const { sessionId } = input;
  if (input.result.isError === true) {
    await postCallbackPayload({
      payload: {
        callId: input.result.callId,
        error: input.result.output,
        kind: "turn.failed",
        outcome: input.result.outcome,
        sessionId,
        subagentName: input.result.subagentName,
      },
      url: input.url,
    });
    return;
  }

  await postCallbackPayload({
    payload: {
      callId: input.result.callId,
      kind: "turn.completed",
      outcome: input.result.outcome,
      output: input.result.output,
      sessionId,
      subagentName: input.result.subagentName,
    },
    url: input.url,
  });
}

export const NOT_PENDING_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

async function postCallbackPayload(input: {
  readonly payload: unknown;
  readonly url: string;
}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await postSessionCallbackRequest({
      body: input.payload,
      url: input.url,
    });
    if (response.ok) return;
    if (!(await isCallbackNotPending(response))) {
      throw new Error(`Turn callback failed with HTTP ${response.status}.`);
    }
    const delay = NOT_PENDING_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      log.warn("turn caller no longer waits for this result", {
        kind: Reflect.get(input.payload as object, "kind"),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function isCallbackNotPending(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body: unknown = await response.json().catch(() => undefined);
  if (body === null || typeof body !== "object") return false;
  return (
    Reflect.get(body, "code") === REMOTE_CALLBACK_NOT_PENDING ||
    Reflect.get(body, "error") === REMOTE_CALLBACK_NOT_PENDING_MESSAGE
  );
}

function directTaskFrom(input: {
  readonly callId: string;
  readonly directTask: NonNullable<TurnCaller["directTask"]>;
  readonly sessionId: string;
}) {
  return {
    callId: input.callId,
    runId: input.sessionId,
    sequence: input.directTask.sequence,
    stepIndex: input.directTask.stepIndex,
    taskId: input.directTask.taskId,
    toolName: input.directTask.toolName,
    turnId: input.directTask.turnId,
  };
}

function directTaskTurnMessage(input: {
  readonly caller: TurnCaller;
  readonly directTask: NonNullable<TurnCaller["directTask"]>;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
  readonly usage?: TokenUsage;
}): WorkflowToolRunMessage {
  const from = directTaskFrom({
    callId: input.caller.callId,
    directTask: input.directTask,
    sessionId: input.sessionId,
  });
  const usageField = input.usage === undefined ? {} : { usage: input.usage };
  if (input.settled.isError === true) {
    return {
      from,
      kind: "outcome",
      result: {
        error: `The agent's turn failed: ${toErrorMessage(input.settled.output)}\nThis task has ended; to retry, call ${input.directTask.toolName} without taskId.`,
        status: "failed",
      },
      ...usageField,
    };
  }
  if (input.lifecycle === "terminal") {
    return {
      from,
      kind: "outcome",
      result: { output: parseJsonValue(input.settled.output), status: "completed" },
      ...usageField,
    };
  }
  return {
    callIds: [input.caller.callId],
    from,
    kind: "reply",
    output: parseJsonValue(input.settled.output),
    ...usageField,
  };
}

function directTaskCancelledMessage(input: {
  readonly caller: TurnCaller;
  readonly directTask: NonNullable<TurnCaller["directTask"]>;
  readonly lifecycle?: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly usage?: TokenUsage;
}): WorkflowToolRunMessage | undefined {
  const from = directTaskFrom({
    callId: input.caller.callId,
    directTask: input.directTask,
    sessionId: input.sessionId,
  });
  const usageField = input.usage === undefined ? {} : { usage: input.usage };
  if (input.lifecycle === "terminal") {
    return {
      from,
      kind: "outcome",
      result: { reason: "The agent invocation was cancelled.", status: "cancelled" },
      ...usageField,
    };
  }
  return input.usage === undefined ? undefined : { from, kind: "usage", usage: input.usage };
}

async function resumeDirectTaskHook(
  token: string,
  message: WorkflowToolRunMessage,
  callId: string,
): Promise<void> {
  try {
    await resumeRoutedHook(token, message);
  } catch (error) {
    if (!isHookNotFound(error)) throw error;
    log.warn("turn caller hook no longer exists", { callId });
  }
}

async function resumeSettledTurnHook(
  token: string,
  result: RuntimeSubagentChildResult,
): Promise<void> {
  try {
    await resumeRoutedHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch (error) {
    if (!isHookNotFound(error)) {
      throw error;
    }

    log.warn("turn caller hook no longer exists", {
      callId: result.callId,
    });
  }
}
