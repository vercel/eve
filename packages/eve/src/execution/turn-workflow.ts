import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { dispatchTurnRuntimeActionsStep } from "#execution/dispatch-turn-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { claimHookOwnership, closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { runProxyInputRequestStep, turnStep } from "#execution/workflow-steps.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

/** Payloads delivered to the private inbox owned by one active turn. */
export type TurnInboxPayload =
  | HookPayload
  | {
      readonly delivery: DeliverHookPayload;
      readonly kind: "driver-delivery";
      readonly requestId: string;
    };

/**
 * Control payloads emitted from the active turn to its session driver.
 * Older drivers only receive the two legacy terminal variants because they
 * do not advertise the turn-inbox capability.
 */
export type TurnCompletionPayload =
  | {
      readonly action: NextDriverAction;
      readonly bufferedDeliveries?: readonly DeliverHookPayload[];
      readonly kind: "turn-result";
    }
  | { readonly kind: "turn-error"; readonly error: unknown }
  | { readonly continuationToken: string; readonly kind: "turn-continuation-token" }
  | {
      readonly continuationToken: string;
      readonly inboxToken: string;
      readonly kind: "turn-delivery-request";
      readonly requestId: string;
    }
  | { readonly kind: "turn-delivery-accepted"; readonly requestId: string }
  | { readonly kind: "turn-delivery-cancelled"; readonly requestId: string };

export type { TurnWorkflowInput };

/** Runs one complete logical turn, including child-agent waits when supported. */
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
  const iterator = inbox[Symbol.asyncIterator]();
  const bufferedDeliveries: DeliverHookPayload[] = [];
  let currentStepInput: TurnStepInput = input.stepInput;

  // Reports each mid-turn continuation-token change to the driver exactly
  // once so it can rekey the public delivery hook in lock-step with the session.
  let lastToken = input.stepInput.sessionState.continuationToken;
  const syncToken = async (nextToken: string): Promise<void> => {
    if (nextToken === "" || nextToken === lastToken) return;
    lastToken = nextToken;
    await notifyDriverStep({
      completionToken: input.completionToken,
      payload: { continuationToken: nextToken, kind: "turn-continuation-token" },
    });
  };

  try {
    await claimHookOwnership(inbox);

    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            bufferedDeliveries: optionalBufferedDeliveries(bufferedDeliveries),
            kind: "turn-result",
          },
        });
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
        await syncToken(result.sessionState.continuationToken);
        const dispatchResult = await dispatchTurnRuntimeActionsStep({
          parentContinuationToken: inbox.token,
          parentWritable: currentStepInput.parentWritable,
          serializedContext: result.serializedContext,
          sessionState: result.sessionState,
          workflowInterrupt: result.action === "dispatch-workflow-runtime-actions",
        });
        await syncToken(dispatchResult.sessionState.continuationToken);

        const resumed = await waitForRuntimeActionResults({
          bufferedDeliveries,
          completionToken: input.completionToken,
          inbox,
          initialResults: dispatchResult.results,
          iterator,
          parentWritable: currentStepInput.parentWritable,
          pendingActionKeys,
          serializedContext: result.serializedContext,
          sessionState: dispatchResult.sessionState,
          syncToken,
        });
        currentStepInput = {
          input: { kind: "runtime-action-result", results: resumed.results },
          parentWritable: currentStepInput.parentWritable,
          serializedContext: resumed.serializedContext,
          sessionState: resumed.sessionState,
        };
        continue;
      }

      if (result.action === "park") {
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: {
            action: {
              authorizationNames: result.authorizationNames,
              kind: "park",
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            bufferedDeliveries: optionalBufferedDeliveries(bufferedDeliveries),
            kind: "turn-result",
          },
        });
        return;
      }

      await syncToken(result.sessionState.continuationToken);
      currentStepInput = {
        input: undefined,
        parentWritable: currentStepInput.parentWritable,
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      };
    }
  } catch (error) {
    await notifyDriverStep({
      completionToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  } finally {
    await closeHookIterator(iterator);
    await disposeHook(inbox);
  }
}

async function waitForRuntimeActionResults(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly completionToken: string;
  readonly inbox: Hook<TurnInboxPayload>;
  readonly initialResults: readonly RuntimeActionResult[];
  readonly iterator: AsyncIterator<TurnInboxPayload>;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly pendingActionKeys: readonly string[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly syncToken: (nextToken: string) => Promise<void>;
}): Promise<{
  readonly results: readonly RuntimeActionResult[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  let currentSerializedContext = input.serializedContext;
  let currentSessionState = input.sessionState;
  let pendingDeliveryRequest: string | undefined;
  let deliveryRequestIndex = 0;
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
        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: { kind: "turn-delivery-cancelled", requestId: pendingDeliveryRequest },
        });
      }
      return {
        results: ready,
        serializedContext: currentSerializedContext,
        sessionState: currentSessionState,
      };
    }

    if (currentSessionState.hasProxyInputRequests && pendingDeliveryRequest === undefined) {
      pendingDeliveryRequest = `${input.inbox.token}:delivery:${String(deliveryRequestIndex++)}`;
      await notifyDriverStep({
        completionToken: input.completionToken,
        payload: {
          continuationToken: currentSessionState.continuationToken,
          inboxToken: input.inbox.token,
          kind: "turn-delivery-request",
          requestId: pendingDeliveryRequest,
        },
      });
    }

    const next = await input.iterator.next();
    if (next.done) throw new Error("Turn inbox closed before runtime actions completed.");

    const value = next.value;
    if (value.kind === "runtime-action-result") {
      results.push(...value.results);
      continue;
    }

    if (value.kind === "subagent-input-request") {
      const proxyResult = await runProxyInputRequestStep({
        hookPayload: value,
        parentWritable: input.parentWritable,
        serializedContext: currentSerializedContext,
        sessionState: currentSessionState,
      });
      currentSerializedContext = proxyResult.serializedContext;
      currentSessionState = proxyResult.sessionState;
      await input.syncToken(currentSessionState.continuationToken);
      continue;
    }

    // Only `driver-delivery` reaches the inbox for public input: children
    // resume it with results/HITL, and the driver relays public deliveries
    // through the request handshake. A stale, non-matching request id means
    // the turn already resolved and the driver re-buffered the delivery.
    if (value.kind === "driver-delivery" && value.requestId === pendingDeliveryRequest) {
      await notifyDriverStep({
        completionToken: input.completionToken,
        payload: { kind: "turn-delivery-accepted", requestId: value.requestId },
      });
      pendingDeliveryRequest = undefined;

      const remainder = await routeDeliverToChildren({
        auth: value.delivery.auth,
        parentWritable: input.parentWritable,
        payloads: value.delivery.payloads,
        sessionState: currentSessionState,
      });
      if (remainder !== undefined) {
        input.bufferedDeliveries.push({ ...value.delivery, payloads: [remainder] });
      }
    }
  }
}

function optionalBufferedDeliveries(
  deliveries: readonly DeliverHookPayload[],
): readonly DeliverHookPayload[] | undefined {
  return deliveries.length === 0 ? undefined : [...deliveries];
}

async function runLegacyTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  let currentStepInput: TurnStepInput = input.stepInput;

  try {
    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "dispatch-workflow-runtime-actions") {
        await notifyDriverStep({
          completionToken: input.completionToken,
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

        await notifyDriverStep({
          completionToken: input.completionToken,
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
    await notifyDriverStep({
      completionToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  }
}

/** Resumes the driver's control hook with one turn lifecycle payload. */
export async function notifyDriverStep(input: {
  readonly completionToken: string;
  readonly payload: TurnCompletionPayload;
}): Promise<void> {
  "use step";

  await resumeHook(input.completionToken, input.payload);
}
