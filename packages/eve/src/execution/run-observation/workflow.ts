import { createHook, sleep } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import { checkpointObservationStep } from "#execution/run-observation/checkpoint-step.js";
import { recordObservationFailureStep } from "#execution/run-observation/failure-step.js";
import {
  applyObservationDeliveryStep,
  applyObservationStatusStep,
  planObservationOperationStep,
  recordObservationDeliveryStep,
} from "#execution/run-observation/delivery-step.js";
import { readLocalObservationPage } from "#execution/run-observation/read-step.js";
import { readRemoteObservationPage } from "#execution/run-observation/remote-read-step.js";
import { resolveSlackObservationStep } from "#execution/run-observation/resolve-slack-step.js";
import { initialObservation } from "#execution/run-observation/state.js";
import {
  markObservationAvailableStep,
  markObservationUnavailableStep,
} from "#execution/run-observation/unavailable-step.js";
import {
  planSlackDelivery,
  type DeliveryReceipt,
} from "#public/channels/slack/observation/plan.js";
import { projectSlackObservation } from "#public/channels/slack/observation/view.js";

export interface RunObservationInput {
  readonly rootSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly expiresAt: string;
  readonly token: string;
}

/** One owner with independent read/checkpoint and provider-delivery branches. */
export async function runObservationWorkflow(input: RunObservationInput): Promise<void> {
  "use workflow";
  const claim = createHook({ token: input.token });
  try {
    await claimHookOwnership(claim);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }

  let observation = initialObservation(input.rootSessionId);
  let receipts: Readonly<Record<string, DeliveryReceipt>> = {};
  let stopped = false;
  let observationFinished = false;
  let confirmedStatus = "";
  let statusConfirmedAt = 0;
  const expiry = new Date(input.expiresAt).getTime();
  try {
    const destination = (await resolveSlackObservationStep(input)).destination;
    const observe = async () => {
      let terminalCatchupRounds = 0;
      while (!stopped && Date.now() < expiry) {
        let progressed = false;
        for (const sourceKey of observation.sourceOrder.slice(0, 32)) {
          const source = observation.sources[sourceKey];
          if (
            source === undefined ||
            (source.parentKey !== undefined && source.parentKey !== input.rootSessionId)
          )
            continue;
          try {
            const page =
              source.remote === undefined
                ? await readLocalObservationPage({
                    sessionId: source.sessionId,
                    startIndex: source.nextIndex,
                  })
                : await readRemoteObservationPage({
                    source,
                    rootSessionId: input.rootSessionId,
                    serializedContext: input.serializedContext,
                  });
            if (page.records.length > 0) {
              progressed = true;
              observation = await checkpointObservationStep({
                state: observation,
                sourceKey,
                records: page.records,
              });
            } else if (source.unavailable && page.outcome !== "partial") {
              observation = await markObservationAvailableStep({ state: observation, sourceKey });
            }
            if (page.outcome === "partial")
              observation = await markObservationUnavailableStep({ state: observation, sourceKey });
            if (page.outcome === "oversized")
              throw new Error("Run observation source record exceeds the fixture limit.");
          } catch (error) {
            // A missing child page cannot settle its task; keep its cursor and report the gap.
            if (
              sourceKey === input.rootSessionId ||
              (error instanceof Error &&
                (error.message.includes("exceeds") || error.message.includes("capacity")))
            )
              throw error;
            observation = await markObservationUnavailableStep({ state: observation, sourceKey });
          }
        }
        if (observation.terminal) {
          terminalCatchupRounds = progressed ? 0 : terminalCatchupRounds + 1;
          if (terminalCatchupRounds >= 3) break;
        }
        await sleep("1s");
      }
      observationFinished = true;
    };
    const deliver = async () => {
      while (!stopped && Date.now() < expiry) {
        if (Object.values(observation.sources).some((source) => source.unsupportedInteraction)) {
          throw new Error(
            "Run observation fixture encountered an unsupported interaction or authorization event.",
          );
        }
        const view = projectSlackObservation(observation);
        if (view.messages.length > 2_000 || Object.keys(receipts).length > 2_000)
          throw new Error("Run observation fixture provider-object capacity exceeded.");
        if (
          view.status !== confirmedStatus ||
          (view.status !== "" && Date.now() - statusConfirmedAt >= 20_000)
        ) {
          if (
            await applyObservationStatusStep({
              serializedContext: input.serializedContext,
              destination,
              status: view.status,
            })
          ) {
            confirmedStatus = view.status;
            statusConfirmedAt = Date.now();
          }
        }
        const operations = planSlackDelivery(view, receipts);
        const next = operations.find((operation) => {
          const due = receipts[operation.key]?.nextAttemptAt;
          return due === undefined || Date.now() >= new Date(due).getTime();
        });
        if (next === undefined) {
          if (observationFinished && operations.length === 0) return;
          await sleep("1s");
          continue;
        }
        const planned = await planObservationOperationStep({
          receipt: receipts[next.key],
          operation: next,
        });
        receipts = { ...receipts, [next.key]: planned };
        const outcome = await applyObservationDeliveryStep({
          serializedContext: input.serializedContext,
          destination,
          ownerId: input.rootSessionId,
          operation: next,
        });
        const receipt = await recordObservationDeliveryStep({ planned, outcome, operation: next });
        receipts = { ...receipts, [next.key]: receipt };
        if (receipt.state === "confirmed") await sleep("1s");
        else if (receipt.state === "blocked") {
          throw new Error(`Run observation delivery blocked: ${receipt.errorCode ?? "unknown"}`);
        } else await sleep("5s");
      }
    };
    const branches = [observe(), deliver()];
    let failure: unknown;
    try {
      await Promise.all(branches);
    } catch (error) {
      failure = error;
    } finally {
      stopped = true;
      await Promise.allSettled(branches);
      if (confirmedStatus !== "") {
        await applyObservationStatusStep({
          serializedContext: input.serializedContext,
          destination,
          status: "",
        }).catch(() => {});
      }
    }
    if (failure !== undefined || Date.now() >= expiry) {
      const reason =
        failure === undefined
          ? "expired"
          : Object.values(receipts).some((receipt) => receipt.state === "blocked")
            ? "delivery_blocked"
            : Object.values(observation.sources).some((source) => source.unsupportedInteraction)
              ? "unsupported_interaction"
              : "failed";
      const report = await recordObservationFailureStep({ reason, observation, receipts });
      throw new Error(
        `Run observation ${report.reason}; ${report.undelivered.length} Slack objects remain undelivered. Inspect recordObservationFailureStep in the Workflow run.`,
      );
    }
  } finally {
    await claim.dispose();
  }
}
