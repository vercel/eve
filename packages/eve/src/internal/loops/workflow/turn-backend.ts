import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import type { LoopRequest } from "#core/types.js";
import type {
  ChildResults,
  ChildrenHandle,
  GenerateInput,
  SessionState,
  TurnBackend,
} from "#internal/loops/types.js";
import { dispatchRuntimeActionsStep } from "#internal/loops/workflow/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#internal/loops/workflow/dispatch-workflow-runtime-actions-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runProxySubagentEventStep } from "#execution/subagent-event-proxy-step.js";
import type { TurnCancellationControl } from "#execution/turn-cancellation-control.js";
import type { TurnInboxPayload } from "#execution/turn-control-protocol.js";
import type { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { turnStep } from "#internal/loops/workflow/steps.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

/**
 * The Workflow engine's {@link TurnBackend}: `generate` is one durable
 * `turnStep`, `checkpoint` relays state to the driver through the turn
 * control protocol, and `spawnChildren` dispatches the pending child batch
 * and services the turn inbox — result demultiplexing, the public-delivery
 * handshake, proxied subagent HITL events, and the cancellation race all
 * stay below the port.
 */
export class WorkflowTurnBackend implements TurnBackend {
  readonly #bufferedDeliveries: DeliverHookPayload[];
  readonly #cancellation: TurnCancellationControl | undefined;
  readonly #cursor: TurnExecutionCursor;
  readonly #inboxToken: string;
  readonly #iterator: AsyncIterator<TurnInboxPayload>;
  // Delivery request ids stay unique across every wait in this turn. A
  // forwarded delivery left unconsumed when one wait resolves would
  // otherwise reuse a later wait's id and be mis-accepted as that wait's
  // response.
  #deliveryRequestSeq = 0;

  constructor(input: {
    readonly bufferedDeliveries: DeliverHookPayload[];
    readonly cancellation: TurnCancellationControl | undefined;
    readonly cursor: TurnExecutionCursor;
    readonly inboxToken: string;
    readonly iterator: AsyncIterator<TurnInboxPayload>;
  }) {
    this.#bufferedDeliveries = input.bufferedDeliveries;
    this.#cancellation = input.cancellation;
    this.#cursor = input.cursor;
    this.#inboxToken = input.inboxToken;
    this.#iterator = input.iterator;
  }

  async checkpoint(state: SessionState): Promise<void> {
    await this.#cursor.adopt({
      serializedContext: state.serializedContext,
      sessionState: state.durable,
    });
  }

  async generate(input: GenerateInput) {
    return await turnStep(this.#cursor.createStepInput(input.input, this.#cancellation?.signal));
  }

  async spawnChildren(
    state: SessionState,
    requests: readonly LoopRequest[],
  ): Promise<{ readonly handle: ChildrenHandle; readonly state: SessionState }> {
    await this.checkpoint(state);

    const dispatch =
      requests[0]?.kind === "workflow-interrupt"
        ? dispatchWorkflowRuntimeActionsStep
        : dispatchRuntimeActionsStep;
    const dispatched = await dispatch({
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
      parentContinuationToken: this.#inboxToken,
      parentWritable: this.#cursor.parentWritable,
      serializedContext: this.#cursor.serializedContext,
      sessionState: this.#cursor.sessionState,
    });
    await this.#cursor.adopt(dispatched);

    const pendingActionKeys = requests.map((request) => request.key);
    return {
      handle: {
        wait: async () => {
          const results = await this.#waitForRuntimeActionResults(
            pendingActionKeys,
            dispatched.results,
          );
          return { results, state: this.#currentState() };
        },
      },
      state: this.#currentState(),
    };
  }

  #currentState(): SessionState {
    return {
      durable: this.#cursor.sessionState,
      serializedContext: this.#cursor.serializedContext,
    };
  }

  #nextDeliveryRequestId(): string {
    return `${this.#inboxToken}:delivery:${String(this.#deliveryRequestSeq++)}`;
  }

  // `"cancelled"` stays a sentinel rather than a `RuntimeActionResult`
  // variant: that union is the schema-validated wire type projected into
  // harness resume calls, while cancellation is a control-flow outcome of
  // this wait that never leaves the workflow.
  async #waitForRuntimeActionResults(
    pendingActionKeys: readonly string[],
    initialResults: readonly RuntimeActionResult[],
  ): Promise<ChildResults> {
    let pendingDeliveryRequest: string | undefined;
    const results: RuntimeActionResult[] = [...initialResults];

    while (true) {
      const ready = resolveRuntimeActionResultsForKeys({
        pendingKeys: pendingActionKeys,
        results,
      });
      if (ready !== undefined) {
        if (pendingDeliveryRequest !== undefined) {
          // The entry may already be racing public input against this wait.
          // Cancellation keeps that input available for the next parent turn.
          await this.#cursor.send({
            kind: "turn-delivery-cancelled",
            requestId: pendingDeliveryRequest,
          });
        }
        return ready;
      }

      if (this.#cursor.sessionState.hasProxyInputRequests && pendingDeliveryRequest === undefined) {
        pendingDeliveryRequest = this.#nextDeliveryRequestId();
        await this.#cursor.send({
          continuationToken: this.#cursor.sessionState.continuationToken,
          inboxToken: this.#inboxToken,
          kind: "turn-delivery-request",
          requestId: pendingDeliveryRequest,
        });
      }

      const nextPromise = this.#iterator.next();
      // When a cancel wins the race, the dangling inbox `next()` is dropped
      // by disposal in teardown; pre-attach a handler so a late rejection
      // never surfaces as unhandled.
      nextPromise.catch(() => {});
      const next = await (this.#cancellation === undefined
        ? nextPromise
        : Promise.race([nextPromise, this.#cancellation.requested]));
      if (next === "cancel") {
        if (pendingDeliveryRequest !== undefined) {
          // Release the raced public input back to the driver so it stays
          // available for the next turn.
          await this.#cursor.send({
            kind: "turn-delivery-cancelled",
            requestId: pendingDeliveryRequest,
          });
        }
        return "cancelled";
      }
      if (next.done) throw new Error("Turn inbox closed before runtime actions completed.");

      const value = next.value;
      if (value.kind === "runtime-action-result") {
        results.push(...value.results);
        continue;
      }

      if (
        value.kind === "subagent-input-request" ||
        value.kind === "subagent-authorization-event"
      ) {
        const proxyResult = await runProxySubagentEventStep({
          hookPayload: value,
          parentWritable: this.#cursor.parentWritable,
          serializedContext: this.#cursor.serializedContext,
          sessionState: this.#cursor.sessionState,
        });
        await this.#cursor.adopt(proxyResult);
        continue;
      }

      // Only `driver-delivery` reaches the inbox for public input: children
      // resume it with results/HITL, and the driver relays public deliveries
      // through the request handshake. A stale, non-matching request id means
      // the turn already resolved and the driver re-buffered the delivery.
      if (value.kind === "driver-delivery" && value.requestId === pendingDeliveryRequest) {
        await this.#cursor.send({ kind: "turn-delivery-accepted", requestId: value.requestId });
        pendingDeliveryRequest = undefined;

        const remainder = await routeDeliverToChildren({
          auth: value.delivery.auth,
          parentWritable: this.#cursor.parentWritable,
          payloads: value.delivery.payloads,
          sessionState: this.#cursor.sessionState,
        });
        if (remainder !== undefined) {
          this.#bufferedDeliveries.push({ ...value.delivery, payloads: [remainder] });
        }
      }
    }
  }
}
