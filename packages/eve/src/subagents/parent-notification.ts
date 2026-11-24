import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import type { TurnCaller } from "#channel/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { SessionCallbackKey } from "#context/keys.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
  type SubagentAdapterState,
} from "#subagents/adapter-state.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { createLogger } from "#internal/logging.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { platformOf } from "#platform/context.js";
import type { Entities } from "#platform/entities.js";
import { processApp } from "#runtime/app.js";
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
}): Promise<void> {
  "use step";
  const platform = platformOf(processApp().started);

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
      platform,
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
  readonly sessionId: string;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";
  const platform = platformOf(processApp().started);

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
      kind: "parked",
      result: { kind: "cancelled" },
      usageDelta,
    },
    output: error,
    subagentName: input.caller.subagentName,
  };
  const result = input.usage === undefined ? base : { ...base, usage: input.usage };
  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      platform,
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

  const ctx = await deserializeContext(input.serializedContext);
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
  readonly platform: Entities;
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
      platform: input.platform,
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
    platform: input.platform,
    url: input.url,
  });
}

export const NOT_PENDING_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

async function postCallbackPayload(input: {
  readonly payload: unknown;
  readonly platform: Entities;
  readonly url: string;
}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await postSessionCallbackRequest({
      body: input.payload,
      platform: input.platform,
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
