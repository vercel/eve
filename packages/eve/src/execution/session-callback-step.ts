import type { SessionCallback } from "#channel/types.js";
import type {
  SessionCallbackPayload,
  SessionCallbackTerminationEvent,
} from "#channel/session-callback.js";
import { parseCallbackMetadata } from "#channel/session-callback.js";
import { SessionCallbackKey } from "#context/keys.js";
import { postSessionCallback } from "#execution/session-callback-post.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

const log = createLogger("execution.session-callback");

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
export async function fireSessionCallbackStep(input: {
  readonly error?: unknown;
  readonly output?: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly status: "completed" | "failed";
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const value = input.serializedContext[SessionCallbackKey.name];
  if (value === undefined) {
    return;
  }

  try {
    const callback = parseSerializedSessionCallback(value);
    await postSessionCallback({
      payload: toPayload({ callback, input, sessionId }),
      url: callback.url,
    });
  } catch (error) {
    log.error("failed to post session callback", {
      error,
      sessionId,
    });
    throw error;
  }
}

function toPayload(args: {
  readonly callback: SessionCallback;
  readonly input: {
    readonly error?: unknown;
    readonly output?: unknown;
    readonly status: "completed" | "failed";
    readonly usage?: TokenUsage;
  };
  readonly sessionId: string;
}): SessionCallbackPayload {
  const { callback, input, sessionId } = args;
  return {
    callId: callback.callId,
    event:
      input.status === "completed"
        ? buildCompletedTerminationEvent({ output: input.output, usage: input.usage })
        : {
            error: {
              code: "SESSION_FAILED",
              message: toErrorMessage(input.error),
            },
            kind: "session.failed",
            status: "termination",
          },
    sessionId,
    subagentName: callback.subagentName,
  };
}

function buildCompletedTerminationEvent(input: {
  readonly output: unknown;
  readonly usage: TokenUsage | undefined;
}): SessionCallbackTerminationEvent {
  const base = {
    kind: "session.completed" as const,
    output: parseJsonValue(input.output ?? ""),
    status: "termination" as const,
  };
  return input.usage === undefined ? base : { ...base, usage: input.usage };
}

function parseSerializedSessionCallback(value: unknown): SessionCallback {
  const parsed = parseCallbackMetadata(value);
  if (!parsed.ok) {
    throw new Error("Serialized session callback is invalid.", {
      cause: parsed.cause,
    });
  }

  return parsed.callback;
}
