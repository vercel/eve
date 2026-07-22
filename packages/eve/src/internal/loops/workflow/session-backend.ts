import { createHook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, DeliverPayload, HookPayload } from "#channel/types.js";
import type {
  CompletedTurn,
  SessionAdvance,
  SessionBackend,
  SessionState,
  SuspendedTurn,
  TurnHandle,
  TurnOutcome,
  TurnProgramInput,
} from "#internal/loops/types.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import {
  createSessionDeliveryHook,
  type SessionDeliveryHook,
  type SessionDeliveryHookHandle,
} from "#execution/session-delivery-hook.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import { coalesceDeliveries } from "#harness/messages.js";

/** Workflow adapter for the shared session program. */
export class WorkflowSessionBackend implements SessionBackend {
  readonly #authHook: ReturnType<typeof createHook<HookPayload>>;
  readonly #authIterator: AsyncIterator<HookPayload>;
  readonly #bufferedDeliveries: DeliverHookPayload[] = [];
  readonly #deliveryHook: SessionDeliveryHookHandle;
  readonly #driverWritable: WritableStream<Uint8Array>;
  readonly #mode: TurnProgramInput["mode"];
  #disposeSettledTurnControl: (() => Promise<void>) | undefined;

  constructor(input: {
    readonly driverWritable: WritableStream<Uint8Array>;
    readonly mode: TurnProgramInput["mode"];
    readonly sessionId: string;
  }) {
    this.#authHook = createHook<HookPayload>({ token: `${input.sessionId}:auth` });
    this.#authIterator = this.#authHook[Symbol.asyncIterator]();
    this.#deliveryHook = createSessionDeliveryHook(this.#bufferedDeliveries);
    this.#driverWritable = input.driverWritable;
    this.#mode = input.mode;
  }

  async initialize(continuationToken: string): Promise<void> {
    if (continuationToken) await this.#deliveryHook.rekey(continuationToken);
  }

  async dispose(): Promise<void> {
    await this.#disposeSettledTurnControl?.();
    await this.#deliveryHook.dispose();
    // Do not close the iterator: cancellation while awaiting authorization
    // can leave a durable read in flight, and return() waits for that read.
    await disposeHook(this.#authHook);
  }

  async finish(turn: CompletedTurn): Promise<void> {
    const { output, state } = turn;
    const failed = turn.isError === true;

    await fireSessionCallbackStep({
      error: failed ? output : undefined,
      output: failed ? undefined : output,
      serializedContext: state.serializedContext,
      status: failed ? "failed" : "completed",
      usage: failed ? undefined : turn.usage,
    });
    await notifyDelegatedParentStep({
      result: failed
        ? createDelegatedSubagentErrorResult(state.serializedContext, output)
        : createDelegatedSubagentSuccessResult(state.serializedContext, output),
      serializedContext: state.serializedContext,
      usage: failed ? undefined : turn.usage,
    });
  }

  async park(turn: SuspendedTurn): Promise<SessionAdvance> {
    let state = turn.state;

    if (turn.kind === "cancelled") {
      const settled = await settleCancelledTurnStep({
        parentWritable: this.#driverWritable,
        serializedContext: state.serializedContext,
        sessionState: state.durable,
      });
      state = {
        durable: settled.sessionState,
        serializedContext: settled.serializedContext,
      };
    }

    const continuationToken = state.durable.continuationToken;
    if (!continuationToken) {
      throw new Error(
        "Cannot park: no continuation token available. The channel must " +
          "post the first message during the initial turn (anchoring the " +
          "session) or `send()` must be called with an explicit " +
          "continuationToken.",
      );
    }

    await this.#deliveryHook.rekey(continuationToken);

    if (turn.kind === "waiting" && turn.authorizationNames?.length) {
      const payloads = await this.#receiveAuthorizations(turn.authorizationNames.length);
      return {
        delivery: { kind: "deliver", payloads },
        kind: "delivery",
        state,
      };
    }

    while (true) {
      const delivery = await waitForNextDeliver({
        bufferedDeliveries: this.#bufferedDeliveries,
        deliveryHook: this.#deliveryHook,
      });
      if (delivery === null) return { kind: "closed", outcome: { output: "" } };

      const remainder = await routeDeliverToChildren({
        auth: delivery.auth,
        parentWritable: this.#driverWritable,
        payloads: delivery.payloads,
        sessionState: state.durable,
      });
      if (remainder === undefined) continue;

      return {
        delivery: {
          auth: delivery.auth,
          kind: "deliver",
          payloads: [remainder],
          requestId: delivery.requestId,
        },
        kind: "delivery",
        state,
      };
    }
  }

  spawnTurn(input: TurnProgramInput, turnOrdinal: number): TurnHandle {
    const delivery = input.delivery;
    if (delivery?.kind !== "deliver") {
      throw new Error("The session driver can only start a turn from a public delivery.");
    }

    return {
      wait: async (): Promise<TurnOutcome> => {
        const dispatched = await dispatchAndAwaitTurn({
          bufferedDeliveries: this.#bufferedDeliveries,
          capabilities: input.capabilities,
          controlToken: `${input.state.durable.sessionId}:turn-control:${String(turnOrdinal)}`,
          delivery,
          deliveryHook: this.#deliveryHook,
          mode: this.#mode,
          parentWritable: this.#driverWritable,
          serializedContext: input.state.serializedContext,
          sessionState: input.state.durable,
        });
        await this.#disposeSettledTurnControl?.();
        this.#disposeSettledTurnControl = dispatched.dispose;
        return toTurnOutcome(dispatched.action);
      },
    };
  }

  async #receiveAuthorizations(expected: number): Promise<DeliverPayload[]> {
    const payloads: DeliverPayload[] = [];
    while (payloads.length < expected) {
      const next = await this.#authIterator.next();
      if (next.done) break;
      if (next.value.kind === "deliver") payloads.push(...next.value.payloads);
    }
    return payloads;
  }
}

function toTurnOutcome(action: NextDriverAction): TurnOutcome {
  const state: SessionState = {
    durable: action.sessionState,
    serializedContext: action.serializedContext,
  };

  if (action.kind === "done") {
    return {
      isError: action.isError,
      kind: "done",
      output: action.output,
      state,
      usage: action.usage,
    };
  }
  if (action.kind !== "park") {
    throw new Error(`Session driver received unexpected turn action "${action.kind}".`);
  }
  if (action.cancelled === true) return { kind: "cancelled", state };
  return {
    authorizationNames: action.authorizationNames,
    hasPendingAuthorization:
      action.hasPendingAuthorization === true || (action.authorizationNames?.length ?? 0) > 0,
    hasPendingInputBatch: action.hasPendingInputBatch === true,
    kind: "waiting",
    state,
  };
}

async function waitForNextDeliver(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly deliveryHook: SessionDeliveryHook;
}): Promise<DeliverHookPayload | null> {
  if (input.bufferedDeliveries.length > 0) {
    return coalesceDeliveries(input.bufferedDeliveries.splice(0));
  }

  while (true) {
    const first = await input.deliveryHook.next();
    input.deliveryHook.consumeNext();
    if (first.done) return null;
    if (first.value.kind !== "deliver") continue;

    let coalesced = first.value;
    while (true) {
      const ready = await takeReadyPayload(input.deliveryHook.next());
      if (ready === NO_READY_MESSAGE) break;
      input.deliveryHook.consumeNext();
      if (ready.done) break;
      if (ready.value.kind === "deliver") {
        coalesced = coalesceDeliveries([coalesced, ready.value]);
      }
    }
    return coalesced;
  }
}

const NO_READY_MESSAGE = Symbol("no-ready-message");

async function takeReadyPayload<T>(promise: Promise<T>): Promise<T | typeof NO_READY_MESSAGE> {
  await Promise.resolve();
  return await Promise.race([promise, Promise.resolve(NO_READY_MESSAGE)]);
}
