import type { InstrumentationPrincipalSummary } from "#instrumentation/lifecycle.js";
import { isObject } from "#shared/guards.js";
import { boundedPrincipalId } from "#compiled/@vercel/agent-runs/otel.js";

/**
 * The end user a model call serves, as `vercel.user_id`. An `enduser.id` the agent puts in its
 * runtime context wins, since the agent chose to export it; otherwise the turn's principal id,
 * which the trace policy has already decided to record or drop.
 */
export function endUserId(
  runtimeContext: Readonly<Record<string, unknown>> | undefined,
  principal: InstrumentationPrincipalSummary | undefined,
): string | undefined {
  const nested = runtimeContext?.enduser;
  const fromContext = runtimeContext?.["enduser.id"] ?? (isObject(nested) ? nested.id : undefined);
  return boundedPrincipalId(fromContext) ?? principal?.id;
}
