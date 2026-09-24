import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicConnectionEvent } from "#context/dynamic-connection-lifecycle.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  createSessionStartedEvent,
  createTurnStartedEvent,
  type RuntimeIdentity,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { ResolvedAgent } from "#runtime/types.js";

/** Binds dynamic connection lifecycle dispatch to one execution context. */
export function bindDynamicConnections(
  ctx: ContextContainer,
  agent: Pick<ResolvedAgent, "dynamicConnectionResolvers">,
) {
  const resolvers = agent.dynamicConnectionResolvers ?? [];
  const dispatch = (event: UnstampedMessageStreamEvent): Promise<void> =>
    dispatchDynamicConnectionEvent({ ctx, event, resolvers });

  return {
    dispatch,
    async rehydrate(
      state: HarnessEmissionState,
      runtime: RuntimeIdentity,
      turn?: { readonly sequence: number; readonly turnId: string },
    ): Promise<void> {
      if (!state.sessionStarted) return;
      await dispatch(createSessionStartedEvent({ runtime }));
      if (turn !== undefined) await dispatch(createTurnStartedEvent(turn));
    },
  };
}
