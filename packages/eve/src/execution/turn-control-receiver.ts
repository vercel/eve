import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import {
  prependTurnDeliveries,
  takeBufferedDelivery,
  takePriorityDelivery,
  type DeliveryBuffers,
} from "#execution/delivery-buffers.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import { closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";

type DeliveryRequest = Extract<TurnControlPayload, { readonly kind: "turn-delivery-request" }>;

/** Owns one turn's driver-side control hook and public-delivery relay state. */
export class TurnControlReceiver {
  private readonly deliveryBuffers: DeliveryBuffers;
  private readonly control: Hook<TurnControlPayload>;
  private readonly controlIterator: AsyncIterator<TurnControlPayload>;
  private readonly deliveryHook: SessionDeliveryHook;
  private pendingControl: Promise<IteratorResult<TurnControlPayload>> | null = null;
  private pendingDelivery: ReturnType<SessionDeliveryHook["bufferNext"]> | null = null;

  constructor(input: {
    readonly deliveryBuffers: DeliveryBuffers;
    readonly deliveryHook: SessionDeliveryHook;
    readonly token: string;
  }) {
    this.deliveryBuffers = input.deliveryBuffers;
    this.control = createHook<TurnControlPayload>({ token: input.token });
    this.controlIterator = this.control[Symbol.asyncIterator]();
    this.deliveryHook = input.deliveryHook;
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

  /** Services control messages until the active turn returns its terminal driver action. */
  async waitForAction(): Promise<NextDriverAction> {
    while (true) {
      const payload = await this.nextControl(
        "Turn control hook closed before delivering a result.",
      );

      const terminal = this.readTerminalControl(payload);
      if (terminal !== undefined) return terminal;

      if (payload.kind === "turn-delivery-request") {
        const resolved = await this.serviceDeliveryRequest(payload);
        if (resolved !== undefined) return resolved;
      }
    }
  }

  private bufferTurnDeliveries(
    payload: Extract<TurnControlPayload, { readonly kind: "turn-result" }>,
  ): void {
    prependTurnDeliveries(this.deliveryBuffers, payload.bufferedDeliveries);
  }

  private consumeControl(): void {
    this.pendingControl = null;
  }

  private getControlPromise(): Promise<IteratorResult<TurnControlPayload>> {
    this.pendingControl ??= this.controlIterator.next();
    return this.pendingControl;
  }

  private consumeDelivery(): void {
    this.pendingDelivery = null;
  }

  private getDeliveryPromise(): ReturnType<SessionDeliveryHook["bufferNext"]> {
    this.pendingDelivery ??= this.deliveryHook.bufferNext();
    return this.pendingDelivery;
  }

  private async nextControl(
    onClosed: string,
  ): Promise<
    Exclude<TurnControlPayload, { readonly kind: "turn-error" | "turn-continuation-token" }>
  > {
    while (true) {
      const next = await this.getControlPromise();
      this.consumeControl();
      if (next.done) throw new Error(onClosed);
      const payload = next.value;
      if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);
      if (payload.kind === "turn-continuation-token") {
        await this.deliveryHook.rekey(payload.continuationToken);
        continue;
      }
      return payload;
    }
  }

  private readTerminalControl(payload: TurnControlPayload): NextDriverAction | undefined {
    if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);
    if (payload.kind !== "turn-result") return undefined;
    this.bufferTurnDeliveries(payload);
    return payload.action;
  }

  private async serviceDeliveryRequest(
    request: DeliveryRequest,
  ): Promise<NextDriverAction | undefined> {
    await this.deliveryHook.rekey(request.continuationToken);

    let delivery = takePriorityDelivery(this.deliveryBuffers);
    if (delivery === undefined && this.deliveryBuffers.replacedHookDeliveries.length > 0) {
      await this.deliveryHook.drainReady();
      delivery = takeBufferedDelivery(this.deliveryBuffers);
    }

    while (delivery === undefined) {
      const winner = await Promise.race([
        this.getControlPromise().then((value) => ({ kind: "control" as const, value })),
        this.getDeliveryPromise().then((value) => ({ kind: "delivery" as const, value })),
      ]);

      if (winner.kind === "control") {
        this.consumeControl();
        if (winner.value.done) {
          throw new Error("Turn control hook closed during a delivery request.");
        }
        if (winner.value.value.kind === "turn-continuation-token") {
          await this.deliveryHook.rekey(winner.value.value.continuationToken);
          continue;
        }
        const terminal = this.readTerminalControl(winner.value.value);
        if (terminal !== undefined) return terminal;
        if (
          winner.value.value.kind === "turn-delivery-cancelled" &&
          winner.value.value.requestId === request.requestId
        ) {
          return undefined;
        }
        continue;
      }

      this.consumeDelivery();
      if (winner.value === "closed") {
        throw new Error("Session delivery hook closed during a turn delivery request.");
      }

      await this.deliveryHook.drainReady();
      delivery = takeBufferedDelivery(this.deliveryBuffers);
    }

    // Forwarding is provisional until the turn acknowledges it. If the inbox is
    // already gone (the turn ended or was replaced), the turn's terminal or
    // cancellation still re-buffers the delivery for the next parent turn.
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

    return await this.awaitForwardedDelivery(request.requestId, delivery);
  }

  /**
   * Waits for the active turn to resolve a forwarded delivery. The turn either
   * accepts it (consumed) or releases it on cancellation or termination, in
   * which case the delivery returns to the buffer ahead of the turn's own
   * remainders so the next parent turn still observes it in arrival order.
   */
  private async awaitForwardedDelivery(
    requestId: string,
    outstanding: DeliverHookPayload,
  ): Promise<NextDriverAction | undefined> {
    while (true) {
      const payload = await this.nextControl(
        "Turn control hook closed before resolving a forwarded delivery.",
      );

      if (payload.kind === "turn-delivery-accepted") {
        if (payload.requestId === requestId) return undefined;
        continue;
      }

      if (payload.kind === "turn-delivery-cancelled" && payload.requestId === requestId) {
        prependTurnDeliveries(this.deliveryBuffers, [outstanding]);
        return undefined;
      }

      if (payload.kind === "turn-result") {
        prependTurnDeliveries(this.deliveryBuffers, [outstanding]);
      }

      const terminal = this.readTerminalControl(payload);
      if (terminal !== undefined) return terminal;
    }
  }
}
