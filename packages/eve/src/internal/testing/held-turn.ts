import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Ends a turn held on a sign-in or tool approval the way cancelling it does,
 * leaving the request open between turns. Harness tests use it to reach that
 * state without driving the session's cancel path.
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
