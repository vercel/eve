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

export interface AdmittedDelivery extends DeliveryAdmittedData {
  readonly recorded?: boolean;
  readonly ignored?: { readonly reason?: string };
}

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

export function settleControl(settlement: ControlSettlement): Commit {
  return commitOf(controlSettled(settlement));
}

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

export function settleDelivery(
  deliveryId: string,
  outcome: "applied" | "failed",
  reason?: string,
): Commit {
  return commitOf([fact("delivery.settled", { deliveryId, outcome, reason })]);
}

export function endSession(
  projection: Pick<SessionProjection, "view"> | undefined,
  ending: Parameters<typeof sessionEndedFacts>[1],
): Commit {
  return commitOf(sessionEndedFacts(projection, ending));
}
