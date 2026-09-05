import {
  findRunningAgentHandle,
  isInboxSubagentResultFromRunningHandle,
} from "#subagents/handles/query.js";
import {
  isInboxSubagentResultFromRecordedWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { preserveSerializedSessionDynamicModelSelection } from "#context/serialized-dynamic-model-selection.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { sendTurnControlStep, type TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import {
  type ChannelReader,
  createChannelReader,
  raceChannelReads,
} from "#execution/tools/workflow/owner-channels.js";
import {
  openWorkflowToolRunOwnerInbox,
  type WorkflowToolRunOwnerInbox,
} from "#execution/tools/workflow/owner.js";
import {
  createTurnCancellationControl,
  type TurnCancellationControl,
} from "#execution/turn-cancellation-control.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { turnStep } from "#execution/workflow-steps.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import { handleWorkflowToolRunMessage } from "#execution/turn-workflow-tool-run.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

export type { TurnWorkflowInput };

/**
 * Runs one complete logical turn, including child-agent waits when supported.
 *
 * The turn-owned path also owns turn cancellation: resuming the
 * turn-private cancel hook (`{completionToken}:cancel`) mid-turn aborts the
 * signal serialized into every `turnStep` and settles the turn as
 * `turn.cancelled` → `session.waiting` — never as a failure. A late or
 * guard-mismatched cancel is a benign no-op.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);

  if (input.driverCapabilities?.turnInbox !== true) {
    return runLegacyTurnWorkflow(input);
  }

  return runTurnOwnedWorkflow(input);
}

export async function runTurnOwnedWorkflow(
  input: TurnWorkflowInput,
  onReady?: () => void,
): Promise<void> {
  const inbox = createHook<TurnInboxPayload>({ token: `${input.completionToken}:inbox` });
  // Hook promises and iterators share one durable cursor. Create the iterator before
  // claiming so conflict replay is consumed by getConflict(), not a later iterator read.
  const inboxReader = createChannelReader("inbox", inbox);
  let initialStep = input.initialStep;
  const cursor = new TurnExecutionCursor({
    controlToken: input.completionToken,
    parentWritable: input.stepInput.parentWritable,
    serializedContext:
      initialStep?.beforeStep.serializedContext ?? input.stepInput.serializedContext,
    sessionState: initialStep?.beforeStep.sessionState ?? input.stepInput.sessionState,
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

    const workflowToolRunInbox = openWorkflowToolRunOwnerInbox();
    const readers: TurnReaders = [workflowToolRunInbox.reader, inboxReader];

    // Claimed after the inbox claim so a losing duplicate run never
    // contends for the session cancel token.
    if (input.driverCapabilities?.cancelledTurnSettle === true) {
      cancellation = await createTurnCancellationControl({
        controlToken: input.completionToken,
        expectedTurnId: activeTurnId(cursor.sessionState.emissionState),
        initialPayload: input.initialCancellation,
      });
    }

    onReady?.();

    while (true) {
      const beforeStep = initialStep?.beforeStep ?? {
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      };
      const result =
        initialStep?.result ??
        (await turnStep(cursor.createStepInput(nextStepInput, cancellation?.signal)));
      initialStep = undefined;
      const pendingCallIds =
        result.action === "park" ? result.pendingCoordinationCallIds : undefined;
      const hasBackgroundTasks = (result.backgroundTasks?.length ?? 0) > 0;

      if (hasBackgroundTasks) {
        if (result.backgroundTaskState === undefined) {
          throw new Error("Background tasks were returned without their committed session state.");
        }
        await cursor.adopt({
          serializedContext: beforeStep.serializedContext,
          sessionState: result.backgroundTaskState,
        });
        await acknowledgeDelegatedTasksStep({ tasks: result.backgroundTasks ?? [] });
      }

      // A cancel observed while the step was returning must still win: the
      // step may have missed the abort and completed normally. Pending
      // runtime-action batches are exempt — their wait observes the signal.
      if (result.action === "cancelled") {
        // The cancelled step returns only the context carve-outs required by
        // the driver epilogue and later turns, plus the accepted user input in
        // durable history. Adopt those before settling so a steered replacement
        // keeps the interrupted request without committing partial model output.
        await cursor.adopt({
          serializedContext: result.serializedContext,
          sessionState: result.backgroundTaskState ?? result.sessionState,
        });
        await finishCancelledTurn({ bufferedDeliveries, cancellation, cursor });
        return;
      }

      if (
        cancellation?.signal.aborted === true &&
        (pendingCallIds === undefined || hasBackgroundTasks)
      ) {
        // Some worlds cannot interrupt a running step, so it can complete
        // normally after the workflow observes cancellation. Roll that result
        // back except for a session model selected by its one-time preamble.
        await cursor.adopt({
          serializedContext: preserveSerializedSessionDynamicModelSelection(
            beforeStep.serializedContext,
            result.serializedContext,
          ),
          sessionState: cursor.sessionState,
        });
        // No `canPark` check here: that gate rejects model-authored waits
        // (`next: null`) in task mode, whereas every session can resume by
        // stable ID after a cancelled turn. The epilogue runs in the driver
        // (`settleCancelledTurnStep`), not as a step in this run, where queued
        // cancel wakes could re-dispatch it.
        await finishCancelledTurn({ bufferedDeliveries, cancellation, cursor });
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
            usageDelta: result.usageDelta,
          },
          bufferedDeliveries,
        );
        return;
      }

      if (pendingCallIds !== undefined && result.action === "park") {
        await cursor.adopt(result);
        const dispatchResult = await dispatchCoordinationStep({
          action: result.action,
          callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
          workflowToolRunOwner: workflowToolRunInbox.owner,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        const initialAcceptedAtMs = dispatchResult.results.length === 0 ? undefined : Date.now();
        await cursor.adopt(dispatchResult);
        await acknowledgeDelegatedTasksStep({ tasks: dispatchResult.pendingTasks });

        const results = await waitForRuntimeActionResults({
          bufferedDeliveries,
          cancellation,
          cursor,
          inboxToken: inbox.token,
          initialAcceptedAtMs,
          initialResults: dispatchResult.results,
          nextDeliveryRequestId,
          readers,
          pendingCallIds,
        });
        if (results === "cancelled") {
          // The next turnStep observes the aborted signal and settles
          // through the `cancelled` arm above.
          nextStepInput = undefined;
          continue;
        }
        if (results === "cancel-turn") {
          await finishCancelledTurn({ bufferedDeliveries, cancellation, cursor });
          return;
        }
        nextStepInput = { kind: "runtime-action-result", ...results };
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
            authorizationAttemptIds: result.authorizationAttemptIds,
            authorizationNames: result.authorizationNames,
            kind: "park",
            settled: result.settled,
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
    // and its hooks unswept. The cancel token is disposed *before* each
    // terminal result publishes so the next turn's claim never races this
    // run's teardown; this backstop covers the error path.
    if (cancellation !== undefined) await cancellation.dispose();
    if (ownsInbox) await disposeHook(inbox);
  }
}

type TurnReaders = readonly [
  WorkflowToolRunOwnerInbox["reader"],
  ChannelReader<"inbox", TurnInboxPayload>,
];

async function finishCancelledTurn(input: {
  readonly bufferedDeliveries: readonly DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
}): Promise<void> {
  const cancellation =
    input.cancellation?.signal.aborted === true ? await input.cancellation.payload : undefined;
  if (cancellation?.tasks === true) {
    await cancelAllIndexedSessionTasksStep({
      serializedContext: input.cursor.serializedContext,
      sessionState: input.cursor.sessionState,
    });
  }
  await cancelDescendantTurnsStep({
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  });
  await input.cancellation?.dispose();
  await input.cursor.finish(
    { sessionState: input.cursor.sessionState },
    { cancelled: true, kind: "park" },
    input.bufferedDeliveries,
  );
}

// These sentinels stay outside `RuntimeActionResult`. That union is the
// schema-validated wire type projected into harness resume calls; these are
// turn-workflow control outcomes that never leave the workflow.
interface AcceptedRuntimeActionBatch {
  readonly acceptedAtMsByCallId: Readonly<Record<string, number>>;
  readonly results: readonly RuntimeActionResult[];
}

async function waitForRuntimeActionResults(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
  readonly inboxToken: string;
  readonly initialAcceptedAtMs: number | undefined;
  readonly initialResults: readonly RuntimeActionResult[];
  readonly nextDeliveryRequestId: () => string;
  readonly pendingCallIds: readonly string[];
  readonly readers: TurnReaders;
}): Promise<AcceptedRuntimeActionBatch | "cancelled" | "cancel-turn"> {
  let pendingDeliveryRequest: string | undefined;
  const results: RuntimeActionResult[] = [...input.initialResults];
  const acceptedAtMsByCallId = new Map<string, number>();
  if (input.initialAcceptedAtMs !== undefined) {
    for (const result of input.initialResults) {
      acceptedAtMsByCallId.set(result.callId, input.initialAcceptedAtMs);
    }
  }

  while (true) {
    const ready = resolveRuntimeActionResultsForCallIds({
      pendingCallIds: input.pendingCallIds,
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
      return {
        acceptedAtMsByCallId: Object.fromEntries(
          ready.map((result) => [result.callId, acceptedAtMsByCallId.get(result.callId)!]),
        ),
        results: ready,
      };
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

    // A read that loses to a cancel stays pending and is dropped by disposal
    // in teardown.
    const read = await raceChannelReads(input.readers, input.cancellation?.requested);
    if (read === "cancel") {
      if (pendingDeliveryRequest !== undefined) {
        // Release the raced public input back to the driver so it stays
        // available for the next turn.
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      return "cancelled";
    }
    if (read.next.done) throw new Error("Turn inbox closed before runtime actions completed.");

    if (read.channel === "workflow") {
      const result = await handleWorkflowToolRunMessage({
        callbackMetadataUrl: getWorkflowMetadata().url,
        cursor: input.cursor,
        message: read.next.value,
      });
      if (result !== undefined) {
        results.push(result);
        acceptedAtMsByCallId.set(result.callId, Date.now());
      }
      continue;
    }

    const value = read.next.value;
    if (value.kind === "runtime-action-result") {
      // The inbox token is shared by every callee in the batch, so an inbox
      // result must bind to the adopted session snapshot: a subagent result
      // to a running agent handle carrying its callId, a tool result to the
      // workflow tool run recorded for its callId. Anything else — a callee settling a
      // sibling's call, or a result for a callId whose dispatch failed — is
      // dropped; the genuine result (or the dispatch error already in
      // `results`) still resolves the wait.
      const sessionSnapshotState = input.cursor.sessionState.snapshot?.session.state;
      const accepted = value.results.filter((result) =>
        result.kind === "tool-result"
          ? isInboxToolResultFromRecordedWorkflowToolRun(sessionSnapshotState, result)
          : (result.origin === "child" &&
              isInboxSubagentResultFromRunningHandle(sessionSnapshotState, result)) ||
            isInboxSubagentResultFromRecordedWorkflowToolRun(sessionSnapshotState, result),
      );
      if (accepted.length > 0) {
        const acceptedAtMs = Date.now();
        results.push(...accepted);
        for (const result of accepted) {
          acceptedAtMsByCallId.set(result.callId, acceptedAtMs);
        }
      }
      continue;
    }

    if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
      const handle = findRunningAgentHandle(input.cursor.sessionState.snapshot?.session.state, {
        callId: value.callId,
      });
      if (
        handle?.identity.name !== value.subagentName ||
        handle.address.sessionId !== value.childSessionId
      ) {
        continue;
      }
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

      const routed = await routeDeliverToChildren({
        delivery: value.delivery,
        parentWritable: input.cursor.parentWritable,
        serializedContext: input.cursor.serializedContext,
        sessionState: input.cursor.sessionState,
      });
      await input.cursor.adopt({
        serializedContext: routed.serializedContext ?? input.cursor.serializedContext,
        sessionState: routed.sessionState ?? input.cursor.sessionState,
      });
      if (routed.kind === "cancel-turn") {
        return routed.kind;
      }
      if (routed.remainder !== undefined) {
        input.bufferedDeliveries.push(routed.remainder);
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
              usageDelta: result.usageDelta,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "park") {
        const pendingCallIds = result.pendingCoordinationCallIds;
        const canPark =
          pendingCallIds !== undefined ||
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        const action: NextDriverAction =
          pendingCallIds !== undefined
            ? {
                kind: "dispatch-coordination",
                pendingCallIds,
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
              }
            : {
                kind: "park",
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
                authorizationAttemptIds: result.authorizationAttemptIds,
                authorizationNames: result.authorizationNames,
                settled: result.settled,
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
