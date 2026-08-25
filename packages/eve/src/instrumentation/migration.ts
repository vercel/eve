import type { ContextContainer } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import {
  migrateSessionInstrumentation,
  planSessionInstrumentation,
  readPlanTraceContext,
  SessionInstrumentationPlanKey,
  type SerializedSessionInstrumentation,
} from "#instrumentation/session-plan.js";

/** Installs a plan once for a workflow context created before plans existed. */
export function ensureSessionInstrumentationPlan(input: {
  readonly agentName?: string;
  readonly ctx: ContextContainer;
  readonly rootSessionId: string;
  readonly runtime: InstrumentationRuntime | undefined;
}): SerializedSessionInstrumentation {
  const existing = input.ctx.get(SessionInstrumentationPlanKey);
  if (existing !== undefined) return existing;

  const session = {
    agentName: input.agentName,
    channel: input.ctx.get(ChannelInstrumentationKey),
    parentTraceContext: input.ctx.get(ParentTraceContextKey),
    rootSessionId: input.rootSessionId,
  };
  const seed = input.ctx.get(SessionTraceSeedKey);
  const plan =
    seed === undefined
      ? planSessionInstrumentation({ runtime: input.runtime, session })
      : migrateSessionInstrumentation({ runtime: input.runtime, seed, session });
  input.ctx.set(SessionInstrumentationPlanKey, plan);
  const traceContext = readPlanTraceContext(plan);
  if (traceContext !== undefined) input.ctx.set(SessionTraceSeedKey, traceContext);
  return plan;
}
