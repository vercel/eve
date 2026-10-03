import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { HumanInput, type Intake } from "#harness/human-input/index.js";

import {
  forwardRelayedAnswersStep,
  mapHeldInputResponsesStep,
  withdrawRelayedRequestsStep,
} from "./steps.js";

// How the session workflow body reaches the human-input steps. A session
// relaying nothing, the common case, skips the durable step.

/**
 * Forwards a delivery's answers to the relayed requests they answer, and
 * returns what is left for this session: `undefined` when nothing, or
 * `cancel-turn` for a relayed budget Stop.
 */
export async function forwardRelayedAnswers(
  delivery: DeliverHookPayload,
  cursor: SessionStateCursor,
): Promise<
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "continue"; readonly remainder: DeliverHookPayload | undefined }
> {
  if (!relaysAnything(cursor)) return { kind: "continue", remainder: delivery };
  const forwarded = await cursor.advance((state) =>
    forwardRelayedAnswersStep({ delivery, ...state }),
  );
  return forwarded.kind === "cancel-turn"
    ? { kind: "cancel-turn" }
    : { kind: "continue", remainder: forwarded.remainder };
}

/** Withdraws what a run relayed once it ended, or the `ctx.ask()` question it withdraws. */
export async function withdrawRelayedRequests(
  cursor: SessionStateCursor,
  intake: Extract<Intake, { readonly type: "run.ended" | "withdraw.requested" }>,
): Promise<void> {
  if (intake.type === "run.ended" && !relaysAnything(cursor)) return;
  await cursor.advance((state) => withdrawRelayedRequestsStep({ ...state, intake }));
}

/**
 * Maps a delivery's channel-specific answers to the requests a held turn waits
 * on. Returns `undefined` when the channel maps none of them.
 */
export async function mapHeldInputResponses(
  cursor: SessionStateCursor,
  delivery: DeliverHookPayload,
  requestIds: ReadonlySet<string>,
): Promise<DeliverHookPayload | undefined> {
  const mapped = await cursor.advance((state) =>
    mapHeldInputResponsesStep({ delivery, requestIds: [...requestIds], ...state }),
  );
  return mapped.delivery;
}

function relaysAnything(cursor: SessionStateCursor): boolean {
  return HumanInput.read(cursor.sessionState.snapshot.session.state).relayedRequestIds().size > 0;
}
