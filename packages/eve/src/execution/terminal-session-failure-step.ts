import { errorInfoOf } from "#harness/facts.js";
import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { summarizeFailure } from "#execution/failure-summary.js";
import { createLogger } from "#internal/logging.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

const log = createLogger("execution.workflow-entry");

/** Emits a terminal `session.ended` to the adapter and durable stream. */
export async function emitTerminalSessionFailureStep(input: {
  readonly error: unknown;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly turnId?: string;
  readonly usage: TokenUsage | undefined;
  /** The session's last checkpointed projection. */
  readonly projection?: SessionProjection;
  readonly sessionState?: DurableSessionState;
}): Promise<void> {
  "use step";

  const { code, details, message } = summarizeFailure(input.error, "WORKFLOW_EXECUTION_FAILED");
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  log.error("workflow loop threw — ending the session failed", {
    sessionId,
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    code,
  });

  await publishTerminalSessionEvent({
    ending: {
      cause: input.turnId === undefined ? undefined : { turnId: input.turnId },
      error: errorInfoOf({ code, details, message }),
      outcome: "failed",
    },
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    projection: input.projection,
    sessionState: input.sessionState,
    serializedContext: input.serializedContext,
    sessionWritable: input.sessionWritable,
    turnId: input.turnId,
  });
}
