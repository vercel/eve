import type { DurableSessionState } from "#execution/durable-session-store.js";
import { getHarnessEmissionState } from "#harness/emission-state.js";
import { getTurnUsageState } from "#harness/turn-tag-state.js";
import { getWorld } from "#internal/workflow/runtime.js";
import type { EveAttributeValue } from "#runtime/attributes/normalize.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";

export function buildSessionWorkflowSummaryAttributes(
  sessionState: DurableSessionState,
): Record<string, EveAttributeValue> {
  const session = sessionState.snapshot.session;
  const usageState = getTurnUsageState(session.state);
  const usage = usageState?.session;

  return {
    "$eve.turn_count": getHarnessEmissionState(session.state).sequence,
    "$eve.model": usageState?.model,
    "$eve.session_input_tokens": usage?.inputTokens,
    "$eve.session_output_tokens": usage?.outputTokens,
    "$eve.session_cache_read_tokens": usage?.cacheReadTokens,
    "$eve.session_cache_write_tokens": usage?.cacheWriteTokens,
    "$eve.session_cost_usd": usage?.sawCost ? usage.costUsd : undefined,
  };
}

export async function writeSessionWorkflowSummary(input: {
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  const attributes = normalizeEveAttributes(
    buildSessionWorkflowSummaryAttributes(input.sessionState),
  );
  const changes = Object.entries(attributes).map(([key, value]) => ({ key, value }));
  if (changes.length === 0) return;

  const world = await getWorld();
  const setAttributes = world.runs.experimentalSetAttributes;
  if (typeof setAttributes !== "function") return;
  await setAttributes.call(world.runs, input.sessionId, changes, {
    allowReservedAttributes: true,
  });
}

/** Updates the anchored session row after one in-session turn settles. */
export async function writeSessionWorkflowSummaryStep(input: {
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";
  await writeSessionWorkflowSummary(input);
}

(
  writeSessionWorkflowSummaryStep as typeof writeSessionWorkflowSummaryStep & {
    maxRetries: number;
  }
).maxRetries = 2;
