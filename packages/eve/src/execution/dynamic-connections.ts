import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicConnectionEvent } from "#context/dynamic-connection-lifecycle.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import {
  sessionStartedForResolvers,
  turnStartedForResolvers,
} from "#harness/session-machine/resolver-events.js";
import type { RuntimeIdentity, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedAgent } from "#runtime/types.js";

/** Binds dynamic connection lifecycle dispatch to one execution context. */
export function bindDynamicConnections(
  ctx: ContextContainer,
  agent: Pick<ResolvedAgent, "dynamicConnectionResolvers">,
) {
  const resolvers = agent.dynamicConnectionResolvers ?? [];
  const dispatch = async (event: UnstampedMessageStreamEvent): Promise<void> => {
    await dispatchDynamicConnectionEvent({ ctx, event, resolvers });
  };

  return {
    dispatch,
    async rehydrate(
      state: TurnPosition,
      runtime: RuntimeIdentity,
      turn?: { readonly sequence: number; readonly turnId: string },
    ): Promise<void> {
      if (!state.sessionStarted) return;
      await dispatch(sessionStartedForResolvers(runtime));
      if (turn !== undefined) await dispatch(turnStartedForResolvers(turn));
    },
  };
}
