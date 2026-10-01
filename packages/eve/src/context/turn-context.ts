import type { AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission-state.js";
import { getTurnClientContextState } from "#harness/turn-client-context.js";
import type { HarnessSession } from "#harness/types.js";
import type { ClientContextValue } from "#internal/client-context.js";

/** The active turn's `clientContext`, exposed as `ctx.turn.context`. */
export const TurnContextKey = new ContextKey<ClientContextValue | undefined>("eve.turnContext");

export function restoreTurnContext(
  ctx: AlsContext,
  session: Pick<HarnessSession, "state">,
  turnId = activeTurnId(getHarnessEmissionState(session.state)),
): void {
  ctx.setVirtualContext(TurnContextKey, getTurnClientContextState(session.state, turnId)?.value);
}
