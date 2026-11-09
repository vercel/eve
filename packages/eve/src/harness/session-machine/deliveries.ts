import {
  controlAdmitted,
  controlSettled,
  deliveryApplied,
  fact,
  sessionEndedFacts,
  type ControlSettlement,
} from "#harness/facts.js";
import type { Commit, ControlDelivery } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { DeliveryAdmittedData } from "#protocol/session-events/families/delivery.js";
import type { SessionStartedData } from "#protocol/session-events/families/session.js";
import { commitOf } from "./commit.js";

// The session and delivery family's commits. The runtime decides when a delivery arrives, a
// control applies, or the session ends, including when no agent can load to end it; the kernel
// builds what records it. None of these needs more than the session's projection.

/** A delivery as a step admits it: recorded unless an earlier attempt did, ignored or consumed. */
export interface AdmittedDelivery extends DeliveryAdmittedData {
  /** An interrupted attempt already recorded its admission. */
  readonly recorded?: boolean;
  /** Nothing consumes it: it settles `ignored`, with why when given. */
  readonly ignored?: { readonly reason?: string };
}

/**
 * One step's admission: the session's start, when it hasn't, then each delivery admitted, and each
 * ignored one settled.
 */
export function admitDeliveries(
  deliveries: readonly AdmittedDelivery[],
  options: { readonly start?: SessionStartedData } = {},
): Commit {
  const { start } = options;
  return commitOf([
    ...(start === undefined ? [] : [fact("session.started", start)]),
    ...deliveries.flatMap(({ ignored, recorded, ...admitted }) => [
      ...(recorded === true ? [] : [fact("delivery.admitted", admitted)]),
      ...(ignored === undefined
        ? []
        : [
            fact("delivery.settled", {
              deliveryId: admitted.deliveryId,
              outcome: "ignored",
              reason: ignored.reason,
            }),
          ]),
    ]),
  ]);
}

/** A control is admitted, and applied at once when `applied`: nothing waits on it. */
export function admitControl(
  delivery: ControlDelivery,
  control: string,
  options: { readonly applied?: true } = {},
): Commit {
  return commitOf([
    controlAdmitted(delivery, control),
    ...(options.applied === true ? [deliveryApplied(delivery.deliveryId)] : []),
  ]);
}

/** A control's admission and settlement, together. */
export function settleControl(settlement: ControlSettlement): Commit {
  return commitOf(controlSettled(settlement));
}

/**
 * A control an interrupted step left unsettled fails rather than run again; an attempt that
 * recorded its admission doesn't record it twice.
 */
export function failInterruptedControl(
  delivery: ControlDelivery,
  control: string,
  options: { readonly recorded: boolean },
): Commit {
  return commitOf([
    ...(options.recorded ? [] : [controlAdmitted(delivery, control)]),
    fact("delivery.settled", {
      deliveryId: delivery.deliveryId,
      outcome: "failed",
      reason: `${control}-interrupted`,
    }),
  ]);
}

/** A delivery the step admitted settles: applied, or failed with why. */
export function settleDelivery(
  deliveryId: string,
  outcome: "applied" | "failed",
  reason?: string,
): Commit {
  return commitOf([fact("delivery.settled", { deliveryId, outcome, reason })]);
}

/**
 * The session ends. It needs only what the stream recorded, since a session ends exactly when its
 * agent may not load: the writer closes what it leaves open.
 */
export function endSession(
  projection: Pick<SessionProjection, "view"> | undefined,
  ending: Parameters<typeof sessionEndedFacts>[1],
): Commit {
  return commitOf(sessionEndedFacts(projection, ending));
}
