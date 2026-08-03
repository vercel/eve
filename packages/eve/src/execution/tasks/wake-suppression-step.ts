import type { DeliverPayload } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { consumeAwaitedTaskWakes } from "#tasks/wake-suppression.js";

/** Filters task wake payloads already consumed by a completed `task_await`. */
export async function filterAwaitedTaskWakePayloadsStep(input: {
  readonly payloads: readonly DeliverPayload[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly payloads: readonly DeliverPayload[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable,
    turnAgent: bundle.turnAgent,
  });
  const filtered = consumeAwaitedTaskWakes(session, input.payloads);
  return {
    payloads: filtered.payloads,
    sessionState:
      filtered.session === session
        ? input.sessionState
        : createDurableSessionState({ session: filtered.session }),
  };
}
