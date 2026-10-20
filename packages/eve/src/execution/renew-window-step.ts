import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { renewDescendantWindows } from "#execution/renew-descendant-windows.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { readHitlState } from "#harness/hitl/requests.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { renewSessionUsageWindow } from "#harness/turn-tag-state.js";
import { openInputs } from "#protocol/session-projection.js";

/**
 * Starts a new window here, then in this session's own runs. The session-limit
 * prompts still open here are obsolete: a relayed one renews nothing if
 * someone answers it later, and the session's own are returned as `approved`.
 */
export async function renewSessionUsageWindowStep(
  input: SessionStepState & { readonly renewalId: string },
): Promise<SessionStateTransition & { readonly approved: readonly string[] }> {
  "use step";
  return await withSessionStateDelta(input, async (state) => {
    const session = readDurableSession(state.sessionState);
    const prompts = openInputs(storedProjection(session.state))
      .filter((open) => open.request.kind === "session-limit")
      .map((open) => open.request.requestId);
    const renewed = renewSessionUsageWindow(session, state.renewalId, prompts);
    if (!renewed.renewed) return { approved: [] };
    await renewDescendantWindows(renewed.session, state.renewalId);
    const relays = readHitlState(session.state).relays;
    return {
      approved: prompts.filter((requestId) => !relays.has(requestId)),
      sessionState: replaceDurableSessionSnapshot({
        session: renewed.session,
        state: state.sessionState,
      }),
    };
  });
}

/** Tells this session's running descendants about a renewal the session applied in its own step. */
export async function renewDescendantWindowsStep(input: {
  readonly renewalId: string;
  readonly sessionState: SessionStepState["sessionState"];
}): Promise<void> {
  "use step";
  await renewDescendantWindows(readDurableSession(input.sessionState), input.renewalId);
}
