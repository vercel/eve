import type { SessionCallback } from "#channel/types.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { SessionCallbackKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { TASK_PROTOCOL_VERSION } from "#tasks/protocol.js";

const log = createLogger("execution.session-callback");

/** A task-mode run's result for its session callback. */
export interface SessionCallbackResult {
  readonly error?: unknown;
  readonly output?: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly status: "completed" | "failed";
  readonly usage?: TokenUsage;
}

/**
 * Sends the configured session terminal callback.
 *
 * Absence is a no-op. Once callback metadata is present, delivery is part of
 * the remote delegation result path, so failures are logged and rethrown
 * instead of being reported as a successful terminal step. Throwing is
 * intentional: this function runs as a durable Workflow step, so rejection
 * hands retry/failure policy back to the Workflow orchestrator rather than
 * letting eve falsely mark the callback delivery as complete.
 *
 * `usage` — the session's token totals — rides along on completed
 * callbacks so the caller can attribute this agent's spend. Failed
 * callbacks never carry usage.
 */
export async function fireSessionCallbackStep(input: SessionCallbackResult): Promise<void> {
  "use step";

  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const value = input.serializedContext[SessionCallbackKey.name];
  if (value === undefined) {
    return;
  }

  let callback: SessionCallback;
  try {
    callback = parseSerializedSessionCallback(value);
  } catch (error) {
    log.error("invalid session callback metadata", { error, sessionId });
    throw error;
  }
  const body =
    input.status === "completed"
      ? buildCompletedCallbackBody({
          callback,
          output: input.output,
          sessionId,
          usage: input.usage,
        })
      : {
          callId: callback.callId,
          error: {
            code: EXECUTION_FAILED,
            message: toErrorMessage(input.error),
          },
          kind: "session.failed" as const,
          sessionId,
          subagentName: callback.subagentName,
          taskProtocol: TASK_PROTOCOL_VERSION,
          usage: input.usage,
        };

  const response = await postSessionCallbackRequest({ body, url: callback.url });

  if (!response.ok) {
    throw new Error(`Session callback failed with HTTP ${response.status}.`);
  }
}

function buildCompletedCallbackBody(input: {
  readonly callback: SessionCallback;
  readonly output: unknown;
  readonly sessionId: string;
  readonly usage: TokenUsage | undefined;
}): Record<string, unknown> {
  const base = {
    callId: input.callback.callId,
    kind: "session.completed" as const,
    output: input.output ?? "",
    sessionId: input.sessionId,
    subagentName: input.callback.subagentName,
    taskProtocol: TASK_PROTOCOL_VERSION,
  };
  return input.usage === undefined ? base : { ...base, usage: input.usage };
}

function parseSerializedSessionCallback(value: unknown): SessionCallback {
  const parsed = parseSessionCallback(value);
  if (!parsed.ok) {
    throw new Error("Serialized session callback is invalid.", {
      cause: parsed.cause,
    });
  }

  return parsed.callback;
}
