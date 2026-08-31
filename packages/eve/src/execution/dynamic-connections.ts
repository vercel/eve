import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicConnectionEvent } from "#context/dynamic-connection-lifecycle.js";
import { activeTurnId } from "#harness/active-turn-id.js";
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
      betweenTurns: boolean,
    ): Promise<void> {
      if (!state.sessionStarted) return;
      await dispatch(createSessionStartedEvent({ runtime }));
      if (betweenTurns) return;
      await dispatch(
        createTurnStartedEvent({ sequence: state.sequence, turnId: activeTurnId(state) }),
      );
    },
  };
}
