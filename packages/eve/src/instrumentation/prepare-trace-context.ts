import { createLogger, formatError } from "#internal/logging.js";
import { contextStorage } from "#context/container.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type {
  InstrumentationParentLineage,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import { sessionIdempotencyKey, turnIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { SessionTraceSeedKey, type SessionTraceSeed } from "#context/keys.js";

const log = createLogger("harness.prepare-trace-context");

/** Prepares native session/turn tracing before their durable stream events. */
export interface PrepareTurnTraceContextInput {
  readonly agentName?: string;
  readonly channelAudience?: ChannelAudience;
  readonly channelType?: string;
  readonly instrumentation?: {
    readonly prepareSessionTrace?: (
      event: InstrumentationSessionStartedEvent,
    ) => Promise<InstrumentationTraceSeed>;
    readonly prepareTurnTrace?: (
      event: InstrumentationTurnStartedEvent,
    ) => Promise<InstrumentationTraceSeed>;
  };
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceSeed;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly sessionStarted: boolean;
  readonly traceContext?: RuntimeTraceContext;
  readonly traceSeed?: SessionTraceSeed;
  readonly turnId: string;
}

export async function prepareTurnTraceContext(
  input: PrepareTurnTraceContextInput,
): Promise<RuntimeTraceContext | undefined> {
  let prepared: InstrumentationTraceSeed | undefined;

  if (!input.sessionStarted && input.instrumentation?.prepareSessionTrace !== undefined) {
    try {
      prepared = await input.instrumentation.prepareSessionTrace({
        agentName: input.agentName,
        channelAudience: input.channelAudience,
        channelType: input.channelType,
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        parentLineage: input.parentLineage,
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId,
        sessionId: input.sessionId,
        traceSeed: input.traceSeed,
        type: "session.started",
      });
    } catch (error) {
      warn("session.started", error);
    }
  }

  if (input.instrumentation?.prepareTurnTrace !== undefined) {
    try {
      prepared = await input.instrumentation.prepareTurnTrace({
        agentName: input.agentName,
        idempotencyKey: turnIdempotencyKey(input.sessionId, input.turnId),
        parentLineage: input.parentLineage,
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId,
        sequence: input.sequence,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: "turn.started",
      });
    } catch (error) {
      warn("turn.started", error);
    }
  }

  if (input.traceSeed === undefined && prepared?.decision !== undefined) {
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
