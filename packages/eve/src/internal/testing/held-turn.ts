import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Moves a session out of the turn held on a sign-in or tool approval without
 * settling the request, leaving it open between turns. Held turns and
 * cancellation no longer reach that state; harness tests use it to keep the
 * cross-turn approval paths covered until they are removed.
 */
export function endHeldTurn(session: HarnessSession): HarnessSession {
  const held = getHarnessEmissionState(session.state);
  return setHarnessEmissionState(session, {
    ...held,
    sequence: held.sequence + 1,
    stepIndex: 0,
    turnId: "",
  });
}
