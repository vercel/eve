import { createLogger, formatError } from "#internal/logging.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type {
  InstrumentationParentLineage,
  InstrumentationTraceContext,
} from "#harness/instrumentation/lifecycle.js";
import { sessionIdempotencyKey, turnIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import type { HarnessInstrumentation } from "#harness/instrumentation/runtime.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

const log = createLogger("harness.prepare-trace-context");

/** Prepares native session/turn tracing before their durable stream events. */
export async function prepareTurnTraceContext(input: {
  readonly agentSessionId?: string;
  readonly agentName?: string;
  readonly channelAudience?: ChannelAudience;
  readonly instrumentation?: HarnessInstrumentation;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly sessionStarted: boolean;
  readonly traceContext?: RuntimeTraceContext;
  readonly turnId: string;
}): Promise<RuntimeTraceContext | undefined> {
  let prepared: RuntimeTraceContext | undefined;

  if (!input.sessionStarted && input.instrumentation?.prepareSessionTrace !== undefined) {
    try {
      prepared = await input.instrumentation.prepareSessionTrace({
        agentSessionId: input.agentSessionId,
        agentName: input.agentName,
        channelAudience: input.channelAudience,
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId,
        sessionId: input.sessionId,
        type: "session.started",
      });
    } catch (error) {
      warn("session.started", error);
    }
  }

  if (input.instrumentation?.prepareTurnTrace !== undefined) {
    try {
      prepared = await input.instrumentation.prepareTurnTrace({
        agentSessionId: input.agentSessionId,
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

  return input.traceContext ?? prepared;
}

function warn(boundary: string, error: unknown): void {
  log.warn("instrumentation trace preparation failed", {
    boundary,
    error: formatError(error),
  });
}
