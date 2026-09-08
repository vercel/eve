import { createLogger, formatError } from "#internal/logging.js";
import { contextStorage } from "#context/container.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type {
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import { sessionIdempotencyKey, turnIdempotencyKey } from "#instrumentation/lifecycle.js";
import { SessionTraceSeedKey } from "#context/keys.js";

const log = createLogger("harness.prepare-trace-context");

/** Prepares native session/turn tracing before their durable stream events. */
export interface PrepareTurnTraceContextInput {
  readonly instrumentation?: {
    readonly prepareSessionTrace?: (
      event: InstrumentationSessionStartedEvent,
    ) => Promise<InstrumentationTraceSeed>;
    readonly prepareTurnTrace?: (
      event: InstrumentationTurnStartedEvent,
    ) => Promise<InstrumentationTraceSeed>;
  };
  readonly session: Omit<InstrumentationSessionStartedEvent, "idempotencyKey" | "type">;
  readonly sequence: number;
  readonly sessionStarted: boolean;
  readonly traceContext?: RuntimeTraceContext;
  readonly turnId: string;
}

export async function prepareTurnTraceContext(
  input: PrepareTurnTraceContextInput,
): Promise<RuntimeTraceContext | undefined> {
  let prepared: InstrumentationTraceSeed | undefined;
  const { channelAudience, channelKind, channelType, traceSeed, ...session } = input.session;

  if (!input.sessionStarted && input.instrumentation?.prepareSessionTrace !== undefined) {
    try {
      prepared = await input.instrumentation.prepareSessionTrace({
        ...session,
        channelAudience,
        channelKind,
        channelType,
        idempotencyKey: sessionIdempotencyKey(session.sessionId),
        traceSeed,
        type: "session.started",
      });
    } catch (error) {
      warn("session.started", error);
    }
  }

  if (input.instrumentation?.prepareTurnTrace !== undefined) {
    try {
      prepared = await input.instrumentation.prepareTurnTrace({
        ...session,
        idempotencyKey: turnIdempotencyKey(session.sessionId, input.turnId),
        sequence: input.sequence,
        turnId: input.turnId,
        type: "turn.started",
      });
    } catch (error) {
      warn("turn.started", error);
    }
  }

  if (traceSeed === undefined && prepared?.decision !== undefined) {
    contextStorage.getStore()?.set(SessionTraceSeedKey, prepared);
  }

  return input.traceContext ?? prepared;
}

function warn(boundary: string, error: unknown): void {
  log.warn("instrumentation trace preparation failed", {
    boundary,
    error: formatError(error),
  });
}
