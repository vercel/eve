import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import type { Intake } from "#harness/human-input/index.js";

import {
  forwardRelayedAnswers,
  mapHeldInputResponses,
  withdrawRelayedRequests,
  type ForwardedRelayedAnswers,
} from "./session.js";

// The durable steps that apply human input around a turn. Only steps live
// here: a `"use step"` module cannot export plain helpers into a workflow body.

/** Forwards the answers a delivery carries for relayed requests; see `forwardRelayedAnswers`. */
export async function forwardRelayedAnswersStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<WithSessionStateDelta<ForwardedRelayedAnswers>> {
  "use step";
  return await withSessionStateDelta(input, forwardRelayedAnswers);
}

/**
 * Withdraws what a run relayed that nobody can answer anymore: everything,
 * once the run ended, or one `ctx.ask()` question the run asks to withdraw.
 */
export async function withdrawRelayedRequestsStep(
  input: SessionStepState & {
    readonly intake: Extract<Intake, { readonly type: "run.ended" | "withdraw.requested" }>;
  },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, withdrawRelayedRequests);
}

/** Maps a delivery's channel-specific answers for a held turn; see `mapHeldInputResponses`. */
export async function mapHeldInputResponsesStep(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<WithSessionStateDelta<{ readonly delivery: DeliverHookPayload | undefined }>> {
  "use step";
  return await withSessionStateDelta(input, async () => await mapHeldInputResponses(input));
}
