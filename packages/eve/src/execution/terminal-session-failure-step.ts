import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { createLogger, formatError } from "#internal/logging.js";
import type { SessionProjection } from "#protocol/session-projection.js";

const log = createLogger("execution.workflow-entry");

/** Emits a terminal `session.failed` to the adapter and durable stream. */
export async function emitTerminalSessionFailureStep(input: {
  readonly error: unknown;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly turnId?: string;
  readonly usage: TokenUsage | undefined;
  /** The session's last checkpointed projection. */
  readonly projection?: SessionProjection;
}): Promise<void> {
  "use step";

  // Cataloged failures replace the raw identity with the curated one; the
  // `detail` dump stays attached to the private event so the session trace
  // keeps the raw evidence while the transcript shows the actionable summary.
  const formatted = formatError(input.error);
  const summary = summarizeKnownError(input.error);
  let details = formatted;
  if (summary !== null) {
    const curated = {
      ...formatted,
      message: summary.message,
      name: summary.name,
      semanticErrorId: summary.id,
    };
    details = summary.hint === undefined ? curated : { ...curated, hint: summary.hint };
  }
  const code = typeof details.name === "string" ? details.name : "WORKFLOW_EXECUTION_FAILED";
  const message = typeof details.message === "string" ? details.message : String(input.error);
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  log.error("workflow loop threw — ending the session failed", {
    sessionId,
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    code,
  });

  await publishTerminalSessionEvent({
    ending: {
      cause: input.turnId === undefined ? undefined : { turnId: input.turnId },
      error: { code, message },
      outcome: "failed",
    },
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    projection: input.projection,
    serializedContext: input.serializedContext,
    sessionWritable: input.sessionWritable,
    turnId: input.turnId,
  });
}
