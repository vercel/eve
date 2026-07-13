import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { sendTurnControlStep, type TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runProxySubagentEventStep } from "#execution/subagent-event-proxy-step.js";
import {
  createTurnCancellationControl,
  type TurnCancellationControl,
} from "#execution/turn-cancellation-control.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { turnStep } from "#execution/workflow-steps.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

export type { TurnWorkflowInput };

/**
 * Runs one complete logical turn, including child-agent waits when supported.
 *
 * The turn-owned path also owns turn cancellation: resuming the
 * session-scoped cancel hook (`{sessionId}:cancel`) mid-turn aborts a
 * durable signal serialized into every `turnStep` and settles the turn as
 * `turn.cancelled` → `session.waiting` — never as a failure. The payload
 * may carry a `turnId` guard scoping the cancel to the turn the caller
 * observed; resuming after the turn settled (or with a stale guard) is a
 * benign no-op.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);

  if (input.driverCapabilities?.turnInbox !== true) {
    return runLegacyTurnWorkflow(input);
  }

  return runTurnOwnedWorkflow(input);
}

async function runTurnOwnedWorkflow(input: TurnWorkflowInput): Promise<void> {
  const inbox = createHook<TurnInboxPayload>({ token: `${input.completionToken}:inbox` });
  // Hook promises and iterators share one durable cursor. Create the iterator before
  // claiming so conflict replay is consumed by getConflict(), not a later iterator read.
  const iterator = inbox[Symbol.asyncIterator]();
  const cursor = new TurnExecutionCursor({
    controlToken: input.completionToken,
    parentWritable: input.stepInput.parentWritable,
    serializedContext: input.stepInput.serializedContext,
    sessionState: input.stepInput.sessionState,
  });
  // Delivery request ids stay unique across every wait in this turn. A forwarded
  // delivery left unconsumed when one wait resolves would otherwise reuse a later
  // wait's id and be mis-accepted as that wait's response.
  let deliveryRequestSeq = 0;
  const nextDeliveryRequestId = (): string =>
    `${inbox.token}:delivery:${String(deliveryRequestSeq++)}`;
  const bufferedDeliveries: DeliverHookPayload[] = [];
  let nextStepInput = input.stepInput.input;
  let ownsInbox = false;
  let cancellation: TurnCancellationControl | undefined;

  try {
    try {
      await claimHookOwnership(inbox);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    // Claimed after the inbox claim so a losing duplicate run never
    // contends for the session cancel token. Gated on the pinned driver
    // settling `park + cancelled` and on the session being parkable —
    // cancellation settles as a park, and an unparkable session would
    // fail instead. A conflict on the stable token (a crashed prior
    // turn's unswept claim) degrades this turn to uncancellable.
    if (
      input.driverCapabilities?.cancelledTurnSettle === true &&
      (input.mode === "conversation" || input.stepInput.sessionState.continuationToken !== "")
    ) {
      cancellation = await createTurnCancellationControl({
        expectedTurnId: activeTurnId(input.stepInput.sessionState.emissionState),
        sessionId: input.stepInput.sessionState.sessionId,
      });
    }

    while (true) {
      // No race needed: the runtime delivers the abort to the in-flight
      // step attempt, which settles itself as `cancelled`.
      const result = await turnStep(cursor.createStepInput(nextStepInput, cancellation?.signal));

      if (result.action === "cancelled") {
        // The epilogue must not run as a step in this run: queued cancel
        // wakes can re-dispatch in-flight steps here and double-emit it.
        // The driver runs `settleCancelledTurnStep` instead; the `canPark`
        // gate below is bypassed on purpose.
        await cancellation?.dispose();
        await cursor.finish(
          { sessionState: cursor.sessionState },
          { cancelled: true, kind: "park" },
          bufferedDeliveries,
        );
        return;
      }

      if (result.action === "done") {
        await cancellation?.dispose();
        await cursor.finish(
          result,
          {
            kind: "done",
            output: result.output ?? "",
            isError: result.isError,
            usage: result.usage,
          },
          bufferedDeliveries,
        );
        return;
      }

      // A pending runtime-action batch (model-driven `park` or dynamic-workflow
      // interrupt) is resolved in-line so the turn stays alive across the wait;
      // the two arms differ only in their dispatch path.
      const pendingActionKeys =
        result.action === "dispatch-workflow-runtime-actions" || result.action === "park"
          ? result.pendingRuntimeActionKeys
          : undefined;

      if (pendingActionKeys !== undefined) {
        await cursor.adopt(result);
        const dispatch =
          result.action === "dispatch-workflow-runtime-actions"
            ? dispatchWorkflowRuntimeActionsStep
            : dispatchRuntimeActionsStep;
        const dispatchResult = await dispatch({
          callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
          parentContinuationToken: inbox.token,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        await cursor.adopt(dispatchResult);

        const results = await waitForRuntimeActionResults({
          bufferedDeliveries,
          cancellation,
          cursor,
          inboxToken: inbox.token,
          initialResults: dispatchResult.results,
          iterator,
          nextDeliveryRequestId,
          pendingActionKeys,
        });
        if (results === "cancelled") {
          // The signal is aborted; the next turnStep settles through the
          // `cancelled` arm above. Descendants are not cascaded to
          // (layer 3); their late results are dropped.
          nextStepInput = undefined;
          continue;
        }
        nextStepInput = { kind: "runtime-action-result", results };
        continue;
      }

      if (result.action === "park") {
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        await cancellation?.dispose();
        await cursor.finish(
          result,
          {
            authorizationNames: result.authorizationNames,
            kind: "park",
          },
          bufferedDeliveries,
        );
        return;
      }

      await cursor.adopt(result);
      nextStepInput = undefined;
    }
  } catch (error) {
    await cursor.send({ error: normalizeSerializableError(error), kind: "turn-error" });
    throw error;
  } finally {
    // Dispose-only teardown: `iterator.return()` would await a pending
    // durable read that never settles, leaving this run `running` forever
    // and its hooks unswept by the world. The cancel token is session-
    // scoped, so its disposal happens *before* the turn result publishes
    // (in each terminal arm above) — the next turn's claim must never
    // race this run's teardown; this backstop covers the error path.
    if (cancellation !== undefined) await cancellation.dispose();
    if (ownsInbox) await disposeHook(inbox);
  }
}

async function waitForRuntimeActionResults(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
  readonly inboxToken: string;
  readonly iterator: AsyncIterator<TurnInboxPayload>;
  readonly nextDeliveryRequestId: () => string;
  readonly pendingActionKeys: readonly string[];
  readonly initialResults: readonly RuntimeActionResult[];
}): Promise<readonly RuntimeActionResult[] | "cancelled"> {
  let pendingDeliveryRequest: string | undefined;
  const results: RuntimeActionResult[] = [...input.initialResults];

  while (true) {
    const ready = resolveRuntimeActionResultsForKeys({
      pendingKeys: input.pendingActionKeys,
      results,
    });
    if (ready !== undefined) {
      if (pendingDeliveryRequest !== undefined) {
        // The entry may already be racing public input against this wait.
        // Cancellation keeps that input available for the next parent turn.
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      return ready;
    }

    if (input.cursor.sessionState.hasProxyInputRequests && pendingDeliveryRequest === undefined) {
      pendingDeliveryRequest = input.nextDeliveryRequestId();
      await input.cursor.send({
        continuationToken: input.cursor.sessionState.continuationToken,
        inboxToken: input.inboxToken,
        kind: "turn-delivery-request",
        requestId: pendingDeliveryRequest,
      });
    }

    const nextPromise = input.iterator.next();
    const settled = nextPromise.then(
      () => "payload" as const,
      () => "payload" as const,
    );
    const winner = await (input.cancellation === undefined
      ? settled
      : Promise.race([settled, input.cancellation.requested]));
    if (winner === "cancel") {
      if (pendingDeliveryRequest !== undefined) {
        // Release the raced public input back to the driver so it stays
        // available for the next turn.
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      // The dangling inbox `next()` is dropped by disposal in teardown.
      return "cancelled";
    }

    const next = await nextPromise;
    if (next.done) throw new Error("Turn inbox closed before runtime actions completed.");

    const value = next.value;
    if (value.kind === "runtime-action-result") {
      results.push(...value.results);
      continue;
    }

    if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
      const proxyResult = await runProxySubagentEventStep({
        hookPayload: value,
        parentWritable: input.cursor.parentWritable,
        serializedContext: input.cursor.serializedContext,
        sessionState: input.cursor.sessionState,
      });
      await input.cursor.adopt(proxyResult);
      continue;
    }

    // Only `driver-delivery` reaches the inbox for public input: children
    // resume it with results/HITL, and the driver relays public deliveries
    // through the request handshake. A stale, non-matching request id means
    // the turn already resolved and the driver re-buffered the delivery.
    if (value.kind === "driver-delivery" && value.requestId === pendingDeliveryRequest) {
      await input.cursor.send({ kind: "turn-delivery-accepted", requestId: value.requestId });
      pendingDeliveryRequest = undefined;

      const remainder = await routeDeliverToChildren({
        auth: value.delivery.auth,
        parentWritable: input.cursor.parentWritable,
        payloads: value.delivery.payloads,
        sessionState: input.cursor.sessionState,
      });
      if (remainder !== undefined) {
        input.bufferedDeliveries.push({ ...value.delivery, payloads: [remainder] });
      }
    }
  }
}

async function runLegacyTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  let currentStepInput: TurnStepInput = input.stepInput;

  try {
    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
              usage: result.usage,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "dispatch-workflow-runtime-actions") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "dispatch-workflow-runtime-actions",
              pendingActionKeys: result.pendingRuntimeActionKeys,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "park") {
        const pendingActionKeys = result.pendingRuntimeActionKeys;
        const canPark =
          pendingActionKeys !== undefined ||
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        const action: NextDriverAction =
          pendingActionKeys !== undefined
            ? {
                kind: "dispatch-runtime-actions",
                pendingActionKeys,
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
              }
            : {
                kind: "park",
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
                authorizationNames: result.authorizationNames,
              };

        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: { action, kind: "turn-result" },
        });
        return;
      }

      currentStepInput = {
        input: undefined,
        parentWritable: currentStepInput.parentWritable,
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      };
    }
  } catch (error) {
    await sendTurnControlStep({
      controlToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  }
}
