import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import { forwardTurnSteeringStep } from "#execution/forward-turn-steering-step.js";
import { closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionInputQueue } from "#execution/session-input-queue.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";

type DeliveryRequest = Extract<TurnControlPayload, { readonly kind: "turn-delivery-request" }>;

interface OutstandingDelivery {
  readonly delivery: DeliverHookPayload;
  readonly requestId: string;
}

/** Owns one turn's driver-side control hook and public-delivery relay state. */
export class TurnControlReceiver {
  private readonly control: Hook<TurnControlPayload>;
  private readonly controlIterator: AsyncIterator<TurnControlPayload>;
  private readonly inputQueue: SessionInputQueue;
  private deliveryRequest: DeliveryRequest | undefined;
  private outstandingDelivery: OutstandingDelivery | undefined;
  private outstandingSteering: OutstandingDelivery | undefined;
  private pendingControl: Promise<IteratorResult<TurnControlPayload>> | undefined;
  private steeringSequence = 0;
  private steeringToken: string | undefined;

  constructor(input: { readonly inputQueue: SessionInputQueue; readonly token: string }) {
    this.control = createHook<TurnControlPayload>({ token: input.token });
    this.controlIterator = this.control[Symbol.asyncIterator]();
    this.inputQueue = input.inputQueue;
  }

  /** Token passed to the turn workflow so it can publish control messages. */
  get token(): string {
    return this.control.token;
  }

  /** Releases the turn control hook and its iterator. */
  async dispose(): Promise<void> {
    await closeHookIterator(this.controlIterator);
    await disposeHook(this.control);
  }

  /** Services the active turn until it returns one terminal driver action. */
  async waitForAction(): Promise<NextDriverAction> {
    while (true) {
      const event = await this.nextEvent();
      if (event.kind === "control") {
        const terminal = await this.handleControl(event.payload);
        if (terminal !== undefined) return terminal;
      } else {
        await this.handleAdmission(event.result);
      }
    }
  }

  private canAdmitDelivery(): boolean {
    if (this.outstandingDelivery !== undefined || this.outstandingSteering !== undefined) {
      return false;
    }
    return this.steeringToken !== undefined || this.deliveryRequest !== undefined;
  }

  private consumeControl(): void {
    this.pendingControl = undefined;
  }

  private async forwardDelivery(delivery: DeliverHookPayload): Promise<void> {
    const request = this.deliveryRequest;
    if (request === undefined) return;

    try {
      await forwardTurnDeliveryStep({
        inboxToken: request.inboxToken,
        payload: {
          delivery,
          kind: "driver-delivery",
          requestId: request.requestId,
        },
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "HookNotFoundError")) throw error;
    }

    this.outstandingDelivery = { delivery, requestId: request.requestId };
  }

  private async forwardBufferedResponse(): Promise<void> {
    if (
      this.deliveryRequest === undefined ||
      this.outstandingDelivery !== undefined ||
      this.outstandingSteering !== undefined
    ) {
      return;
    }

    const buffered = this.inputQueue.takeExplicitResponse();
    if (buffered !== undefined) await this.forwardDelivery(buffered);
  }

  private async forwardSteering(delivery: DeliverHookPayload): Promise<void> {
    const steeringToken = this.steeringToken;
    if (steeringToken === undefined) return;

    const requestId = `${this.control.token}:steer:${String(this.steeringSequence++)}`;
    try {
      await forwardTurnSteeringStep({
        payload: { delivery, requestId },
        steeringToken,
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "HookNotFoundError")) throw error;
      this.inputQueue.consumeAdmission();
      this.inputQueue.returnSteering(delivery);
      return;
    }

    this.inputQueue.consumeAdmission();
    this.outstandingSteering = { delivery, requestId };
  }

  private getControlPromise(): Promise<IteratorResult<TurnControlPayload>> {
    this.pendingControl ??= this.controlIterator.next();
    return this.pendingControl;
  }

  private async handleAdmission(result: IteratorResult<HookPayload>): Promise<void> {
    if (result.done) {
      throw new Error("Session delivery hook closed while a turn was active.");
    }

    const delivery = result.value;
    if (delivery.kind !== "deliver") {
      this.inputQueue.consumeAdmission();
      return;
    }

    if (delivery.turnPolicy === "steer" && this.steeringToken !== undefined) {
      await this.forwardSteering(delivery);
      return;
    }

    if (this.deliveryRequest !== undefined) {
      this.inputQueue.consumeAdmission();
      await this.forwardDelivery(delivery);
      return;
    }

    this.inputQueue.consumeAdmission();
    this.inputQueue.appendQueued(delivery);
  }

  private async handleControl(payload: TurnControlPayload): Promise<NextDriverAction | undefined> {
    if (payload.kind === "turn-error") {
      throw rebuildSerializableError(payload.error);
    }

    if (payload.kind === "turn-result") {
      if (this.outstandingDelivery !== undefined) {
        this.inputQueue.prependReturned(this.outstandingDelivery.delivery);
      }
      if (this.outstandingSteering !== undefined) {
        this.inputQueue.returnSteering(this.outstandingSteering.delivery);
      }
      if (payload.bufferedDeliveries !== undefined) {
        this.inputQueue.prependTurnRemainders(payload.bufferedDeliveries);
      }
      this.deliveryRequest = undefined;
      this.outstandingDelivery = undefined;
      this.outstandingSteering = undefined;
      return payload.action;
    }

    if (payload.kind === "turn-continuation-token") {
      await this.inputQueue.rekey(payload.continuationToken);
      return undefined;
    }

    if (payload.kind === "turn-steering-ready") {
      this.steeringToken = payload.steeringToken;
      return undefined;
    }

    if (payload.kind === "turn-steering-accepted") {
      if (payload.requestId === this.outstandingSteering?.requestId) {
        this.outstandingSteering = undefined;
        await this.forwardBufferedResponse();
      }
      return undefined;
    }

    if (payload.kind === "turn-delivery-request") {
      this.deliveryRequest = payload;
      await this.inputQueue.rekey(payload.continuationToken);
      await this.forwardBufferedResponse();
      return undefined;
    }

    if (payload.kind === "turn-delivery-accepted") {
      if (payload.requestId === this.outstandingDelivery?.requestId) {
        this.deliveryRequest = undefined;
        this.outstandingDelivery = undefined;
      }
      return undefined;
    }

    if (
      payload.kind === "turn-delivery-cancelled" &&
      payload.requestId === this.deliveryRequest?.requestId
    ) {
      if (payload.requestId === this.outstandingDelivery?.requestId) {
        this.inputQueue.prependReturned(this.outstandingDelivery.delivery);
        this.outstandingDelivery = undefined;
      }
      this.deliveryRequest = undefined;
    }

    return undefined;
  }

  private async nextEvent(): Promise<
    | { readonly kind: "control"; readonly payload: TurnControlPayload }
    | { readonly kind: "delivery"; readonly result: IteratorResult<HookPayload> }
  > {
    const control = this.getControlPromise().then((result) => ({
      kind: "control" as const,
      result,
    }));
    const winner = this.canAdmitDelivery()
      ? await Promise.race([
          control,
          this.inputQueue.nextAdmission().then((result) => ({
            kind: "delivery" as const,
            result,
          })),
        ])
      : await control;

    if (winner.kind === "delivery") return winner;

    this.consumeControl();
    if (winner.result.done) {
      throw new Error("Turn control hook closed before delivering a result.");
    }
    return { kind: "control", payload: winner.result.value };
  }
}
