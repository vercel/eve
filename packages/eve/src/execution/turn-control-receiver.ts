import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { forwardTurnCancellationStep } from "#execution/forward-turn-cancellation-step.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import { closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionCommandInbox, SessionInboxPayload } from "#execution/session-command-inbox.js";
import type { ChannelIdempotencyGuard } from "#execution/channel-idempotency.js";
import { sendCommandToDelivery } from "#execution/session-command-wire.js";
import { turnCancellationHookToken } from "#execution/turn-cancellation-token.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";

type DeliveryRequest = Extract<TurnControlPayload, { readonly kind: "turn-delivery-request" }>;

export type TurnDriverAction = NextDriverAction;

/** Owns one turn's driver-side control hook and public-delivery relay state. */
export class TurnControlReceiver {
  private readonly bufferedDeliveries: DeliverHookPayload[];
  private readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  private readonly commandInbox: SessionCommandInbox;
  private readonly idempotency: ChannelIdempotencyGuard;
  private readonly control: Hook<TurnControlPayload>;
  private readonly controlIterator: AsyncIterator<TurnControlPayload>;
  private pendingControl: Promise<IteratorResult<TurnControlPayload>> | null = null;

  constructor(input: {
    readonly bufferedDeliveries: DeliverHookPayload[];
    readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
    readonly commandInbox: SessionCommandInbox;
    readonly idempotency: ChannelIdempotencyGuard;
    readonly token: string;
  }) {
    this.bufferedDeliveries = input.bufferedDeliveries;
    this.bufferedSessionControls = input.bufferedSessionControls;
    this.commandInbox = input.commandInbox;
    this.idempotency = input.idempotency;
    this.control = createHook<TurnControlPayload>({ token: input.token });
    this.controlIterator = this.control[Symbol.asyncIterator]();
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
  async waitForAction(): Promise<TurnDriverAction> {
    while (true) {
      const winner = await this.nextControlOrCommand();
      if (winner.kind === "command") {
        const terminal = await this.handleSessionCommand(winner.command);
        if (terminal !== undefined) return terminal;
        continue;
      }
      const payload = winner.payload;

      const terminal = this.readTerminalControl(payload);
      if (terminal !== undefined) return terminal;

      if (payload.kind === "turn-delivery-request") {
        const resolved = await this.serviceDeliveryRequest(payload);
        if (resolved !== undefined) return resolved;
      }
    }
  }

  private async handleSessionCommand(
    command: SessionInboxPayload,
  ): Promise<TurnDriverAction | undefined> {
    if (command.kind === "deliver") {
      if (!this.idempotency.accept(command.idempotencyKey)) return undefined;
      this.bufferedDeliveries.push(command);
      return undefined;
    }
    if (command.kind === "send") {
      const delivery = sendCommandToDelivery(command);
      if (!this.idempotency.accept(delivery.idempotencyKey)) return undefined;
      this.bufferedDeliveries.push(delivery);
      return undefined;
    }
    if (command.kind === "clear" || command.kind === "compact") {
      this.bufferedSessionControls.push(command.kind);
      return undefined;
    }
    if (command.kind === "session-timeout") {
      this.bufferedSessionControls.push("expired");
      return undefined;
    }
    if (command.kind === "cancel") {
      await forwardTurnCancellationStep({
        payload: command.turnId === undefined ? {} : { turnId: command.turnId },
        token: turnCancellationHookToken(this.control.token),
      });
      return undefined;
    }
    if (command.kind === "reset") {
      await forwardTurnCancellationStep({
        payload: {},
        token: turnCancellationHookToken(this.control.token),
      });
      this.bufferedSessionControls.push("reset");
      return undefined;
    }
    return unsupportedSessionCommand(command);
  }

  private bufferTurnDeliveries(
    payload: Extract<TurnControlPayload, { readonly kind: "turn-result" }>,
  ): void {
    if (payload.bufferedDeliveries !== undefined) {
      this.bufferedDeliveries.unshift(...payload.bufferedDeliveries);
    }
  }

  private consumeControl(): void {
    this.pendingControl = null;
  }

  private getControlPromise(): Promise<IteratorResult<TurnControlPayload>> {
    this.pendingControl ??= this.controlIterator.next();
    return this.pendingControl;
  }

  private async nextControlOrCommand(): Promise<
    | { readonly command: SessionInboxPayload; readonly kind: "command" }
    | { readonly kind: "control"; readonly payload: TurnControlPayload }
  > {
    const winner = await Promise.race([
      this.getControlPromise().then((value) => ({ kind: "control" as const, value })),
      this.commandInbox.next().then((value) => ({ kind: "command" as const, value })),
    ]);

    if (winner.kind === "command") {
      if (winner.value.done) {
        throw new Error("Session command inbox closed before the active turn settled.");
      }
      this.commandInbox.consumeNext();
      return { command: winner.value.value, kind: "command" };
    }

    this.consumeControl();
    if (winner.value.done) {
      throw new Error("Turn control hook closed before delivering a result.");
    }
    const payload = winner.value.value;
    if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);
    if (payload.kind === "turn-continuation-token") {
      await this.commandInbox.rekeyContinuation(payload.continuationToken);
      return await this.nextControlOrCommand();
    }
    return { kind: "control", payload };
  }

  private readTerminalControl(payload: TurnControlPayload): NextDriverAction | undefined {
    if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);
    if (payload.kind !== "turn-result") return undefined;
    this.bufferTurnDeliveries(payload);
    return payload.action;
  }

  private async serviceDeliveryRequest(
    request: DeliveryRequest,
  ): Promise<TurnDriverAction | undefined> {
    await this.commandInbox.rekeyContinuation(request.continuationToken);

    let delivery = this.bufferedDeliveries.shift();
    while (delivery === undefined) {
      const winner = await Promise.race([
        this.getControlPromise().then((value) => ({ kind: "control" as const, value })),
        this.commandInbox.next().then((value) => ({ kind: "command" as const, value })),
      ]);

      if (winner.kind === "control") {
        this.consumeControl();
        if (winner.value.done) {
          throw new Error("Turn control hook closed during a delivery request.");
        }
        if (winner.value.value.kind === "turn-continuation-token") {
          await this.commandInbox.rekeyContinuation(winner.value.value.continuationToken);
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

      if (winner.value.done) {
        throw new Error("Session command inbox closed during a turn delivery request.");
      }

      this.commandInbox.consumeNext();
      if (winner.value.value.kind === "deliver") {
        if (this.idempotency.accept(winner.value.value.idempotencyKey)) {
          delivery = winner.value.value;
        }
        continue;
      }
      if (winner.value.value.kind === "send") {
        const candidate = sendCommandToDelivery(winner.value.value);
        if (this.idempotency.accept(candidate.idempotencyKey)) delivery = candidate;
        continue;
      }
      const terminal = await this.handleSessionCommand(winner.value.value);
      if (terminal !== undefined) return terminal;
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
   * which case the delivery returns behind remainders from earlier deliveries
   * accepted by the turn and ahead of deliveries that arrived later.
   */
  private async awaitForwardedDelivery(
    requestId: string,
    outstanding: DeliverHookPayload,
  ): Promise<TurnDriverAction | undefined> {
    while (true) {
      const winner = await this.nextControlOrCommand();
      if (winner.kind === "command") {
        const terminal = await this.handleSessionCommand(winner.command);
        if (terminal !== undefined) {
          this.bufferedDeliveries.unshift(outstanding);
          return terminal;
        }
        continue;
      }
      const payload = winner.payload;

      if (payload.kind === "turn-delivery-accepted") {
        if (payload.requestId === requestId) return undefined;
        continue;
      }

      if (payload.kind === "turn-delivery-cancelled" && payload.requestId === requestId) {
        this.bufferedDeliveries.unshift(outstanding);
        return undefined;
      }

      if (payload.kind === "turn-result") {
        this.bufferedDeliveries.unshift(outstanding);
      }

      const terminal = this.readTerminalControl(payload);
      if (terminal !== undefined) return terminal;
    }
  }
}

function unsupportedSessionCommand(command: never): never {
  throw new Error(`Unsupported session command: ${JSON.stringify(command)}`);
}
