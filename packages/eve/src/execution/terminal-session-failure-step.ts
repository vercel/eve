import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext } from "#context/serialize.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { createLogger, formatError } from "#internal/logging.js";
import {
  createSessionFailedEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.workflow-entry");

/** Emits a terminal `session.failed` to the adapter and durable stream. */
export async function emitTerminalSessionFailureStep(input: {
  readonly error: unknown;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  // Cataloged failures replace the raw identity with the curated one; the
  // `detail` dump stays attached so the local diagnostic log keeps the
  // raw evidence while the transcript shows the actionable summary.
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

  log.error("workflow loop threw — emitting terminal session.failed", {
    sessionId,
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    code,
    message,
    hint: summary?.hint,
    detail: typeof details.detail === "string" ? details.detail : undefined,
  });

  const event = createSessionFailedEvent({ code, details, message, sessionId });

  // Best-effort: invoke the adapter handler so channels surface the
  // failure. Errors are logged, never rethrown — the outer workflow
  // throw must still reach the run handle.
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.get(ChannelKey);
    if (adapter !== undefined) {
      const adapterCtx = buildAdapterContext(adapter, ctx);
      await callAdapterEventHandler(adapter, event, adapterCtx);
    }
  } catch (notificationError) {
    log.error("adapter failed to handle terminal session.failed event", {
      errorId: typeof details.errorId === "string" ? details.errorId : undefined,
      sessionId,
      error: notificationError,
    });
  }

  // Always write the event to the durable stream so downstream
  // consumers see a canonical terminal event instead of an abrupt
  // stream close.
  try {
    const writer = input.parentWritable.getWriter();
    try {
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event)));
    } finally {
      writer.releaseLock();
    }
  } catch (writeError) {
    log.error("failed to write terminal session.failed event to durable stream", {
      errorId: typeof details.errorId === "string" ? details.errorId : undefined,
      sessionId,
      error: writeError,
    });
  }
}
