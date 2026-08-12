import { createLogger, formatError } from "#internal/logging.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type {
  InstrumentationParentLineage,
  InstrumentationTraceContext,
} from "#harness/instrumentation-lifecycle.js";
import type { HarnessInstrumentation } from "#harness/instrumentation-runtime.js";

const log = createLogger("harness.prepare-trace-context");

/** Prepares native session/turn tracing before their durable stream events. */
export async function prepareTurnTraceContext(input: {
  readonly agentName?: string;
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
        agentName: input.agentName,
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
