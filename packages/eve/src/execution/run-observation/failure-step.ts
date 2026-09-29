import type { ObservationState } from "#execution/run-observation/state.js";
import {
  slackMessageVersion,
  type DeliveryReceipt,
} from "#public/channels/slack/observation/plan.js";
import { projectSlackObservation } from "#public/channels/slack/observation/view.js";

export interface ObservationFailureReport {
  readonly reason: "expired" | "delivery_blocked" | "unsupported_interaction" | "failed";
  readonly revision: number;
  readonly sources: readonly {
    readonly key: string;
    readonly nextIndex: number;
    readonly unavailable: boolean;
    readonly unsupported: boolean;
  }[];
  readonly undelivered: readonly {
    readonly key: string;
    readonly state: DeliveryReceipt["state"] | "unplanned" | "stale";
    readonly errorCode?: string;
  }[];
}

/** Keeps an operator-readable failure snapshot in the Workflow step journal. */
export async function recordObservationFailureStep(input: {
  readonly reason: ObservationFailureReport["reason"];
  readonly observation: ObservationState;
  readonly receipts: Readonly<Record<string, DeliveryReceipt>>;
}): Promise<ObservationFailureReport> {
  "use step";
  const desired = projectSlackObservation(input.observation);
  return {
    reason: input.reason,
    revision: input.observation.revision,
    sources: input.observation.sourceOrder.map((key) => ({
      key,
      nextIndex: input.observation.sources[key]?.nextIndex ?? 0,
      unavailable: input.observation.sources[key]?.unavailable === true,
      unsupported: input.observation.sources[key]?.unsupported === true,
    })),
    undelivered: desired.messages
      .filter((message) => {
        const receipt = input.receipts[message.key];
        return (
          receipt?.state !== "confirmed" ||
          receipt.providerMessageId === undefined ||
          receipt.appliedVersion !== slackMessageVersion(message)
        );
      })
      .map((message) => {
        const receipt = input.receipts[message.key];
        const undelivered: {
          key: string;
          state: DeliveryReceipt["state"] | "unplanned" | "stale";
          errorCode?: string;
        } = {
          key: message.key,
          state: receipt?.state === "confirmed" ? "stale" : (receipt?.state ?? "unplanned"),
        };
        if (receipt?.errorCode !== undefined) undelivered.errorCode = receipt.errorCode;
        return undelivered;
      }),
  };
}
