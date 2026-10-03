import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import { mapHeldInputResponses } from "#harness/human-input/effects/workflow.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import {
  isSteeringMessage,
  type SteeringOptions,
  type SteeringTurn,
} from "#execution/session/input-queue.js";
import type { SessionExecutionInput } from "#execution/session/turn.js";
import type { SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

export type RuntimeEvent =
  | { readonly kind: "runtime-action-result"; readonly results: readonly RuntimeActionResult[] }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  /** A steering message that answered no pending request arrived during the wait. */
  | { readonly kind: "steering" }
  /** A `task_wait` call's timeout passed. */
  | { readonly kind: "timeout"; readonly callId: string }
  /** A delivery was admitted; it may answer a held turn's request. */
  | { readonly kind: "input" }
  | "cancelled";

/**
 * Admission policy, cancellation, and steering for one active turn.
 * Deliveries admitted while a model step runs stay in the shared queue until
 * the turn reaches a committed boundary; a runtime-action wait reads them as
 * they arrive, so a message can steer it.
 *
 * The pump signals cancellation and eligible steering immediately. Cancellation
 * aborts the turn; steering only interrupts generation before assistant output
 * or local tool execution. Both retain ordered admission at the next boundary.
 */
export class ActiveTurn {
  private readonly admitted = new Set<number>();
  /** Admitted deliveries a runtime wait already checked for steering. */
  private readonly inspected = new Set<number>();
  /** Admitted deliveries the channel already mapped for a held turn's requests. */
  private readonly mappedForHeldRequest = new Set<number>();
  private readonly runtimeResults: RuntimeEvent[] = [];
  private readonly controller = new AbortController();
  private readonly expectedTurnId: string;
  private readonly input: SessionExecutionInput;
  /** Who alone steers the turn: its principal, or its delegated caller. */
  private readonly identity: SteeringTurn;
  private readonly unsubscribe: () => void;
  private unsubscribeDelivery: () => void;
  private steeringController = new AbortController();
  /** The delegated caller of the latest message the turn read. */
  caller: TurnCaller | undefined;
  /** A step of this turn compacted the history. */
  compacted = false;

  constructor(
    input: SessionExecutionInput,
    owner: { readonly caller: TurnCaller | undefined; readonly principal: string },
  ) {
    this.input = input;
    this.caller = owner.caller;
    this.identity = { callerCallId: owner.caller?.callId, principal: owner.principal };
    this.expectedTurnId = activeTurnId(input.cursor.sessionState.emissionState);
    this.unsubscribe = input.inbox.onInterrupt((payload) => {
      if (this.cancelsThisTurn(payload)) this.abort();
    });
    this.unsubscribeDelivery = input.inbox.onDelivery(this.signalSteering);
  }

  private readonly signalSteering = (payload: SessionInboxPayload): void => {
    let delivery;
    try {
      delivery = decodeSessionInboxPayload(payload);
    } catch {
      return;
    }
    if (delivery.kind === "deliver" && isSteeringMessage(delivery, this.identity))
      this.steeringController.abort();
  };

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeDelivery();
  }

  get steeringSignal(): AbortSignal {
    return this.steeringController.signal;
  }

  private resetSteering(): void {
    if (!this.steeringController.signal.aborted) return;
    this.unsubscribeDelivery();
    this.steeringController = new AbortController();
    // Admission can yield while new deliveries are pumped. Replaying the
    // unread inbox keeps those arrivals attached to the next generation.
    this.unsubscribeDelivery = this.input.inbox.onDelivery(this.signalSteering);
  }

  /** Admits everything the pump accepted while the last step ran. */
  async admitBoundary(): Promise<void> {
    const pending = this.input.inbox.drain();
    for (const payload of pending) await this.admit(payload);
  }

  /**
   * Steering admitted during this turn, coalesced.
   * The next step reads it as input, so its signal must not interrupt that
   * step; only deliveries still unread re-signal the next generation.
   */
  async takeSteering(options?: SteeringOptions): Promise<DeliverHookPayload | undefined> {
    const steering: DeliverHookPayload[] = [];
    while (true) {
      const selection = this.input.queue.takeSteering(this.admitted, this.identity, options);
      if (selection === undefined) break;
      for (const sequence of selection.sequences) this.admitted.delete(sequence);
      steering.push(selection.delivery);
    }
    this.resetSteering();
    if (steering.length === 0) return undefined;
    const delivery = steering.length === 1 ? steering[0]! : coalesceDeliveries(steering);
    if (delivery.caller !== undefined) this.caller = delivery.caller;
    return delivery;
  }

  /**
   * Removes the admitted run messages the session applies at once instead of
   * in a runtime wait, or only those of `kind`.
   */
  takeBoundaryMessages(kind?: "agent-started"): WorkflowToolRunMessage[] {
    const taken: WorkflowToolRunMessage[] = [];
    const kept: RuntimeEvent[] = [];
    for (const event of this.runtimeResults) {
      const message = asBoundaryMessage(event);
      if (message === undefined || (kind !== undefined && message.kind !== kind)) kept.push(event);
      else taken.push(message);
    }
    this.runtimeResults.splice(0, this.runtimeResults.length, ...kept);
    return taken;
  }

  /**
   * Next runtime result, workflow message, steering, or timeout, admitting
   * inbox traffic while waiting. Deliveries admitted before the wait began are
   * checked first, so a message that arrived as the calls started still steers.
   * `timers` are durable sleeps raced against the inbox.
   */
  async nextRuntimeEvent(timers: readonly Promise<string>[]): Promise<RuntimeEvent> {
    while (true) {
      const steered = this.checkAdmittedSteering();
      if (this.signal.aborted) return "cancelled";
      if (steered) return { kind: "steering" };
      const event = this.runtimeResults.shift();
      if (event !== undefined) return event;
      const elapsed = await this.waitForInboxOrTimer(timers);
      if (elapsed !== undefined) return { callId: elapsed, kind: "timeout" };
      const payload = await this.input.inbox.next();
      if (payload === undefined)
        throw new Error("Session inbox closed before runtime actions completed.");
      if (await this.admit(payload)) return { kind: "input" };
    }
  }

  /**
   * Takes one admitted delivery that answers an open request, from any
   * responder: an approver need not be the turn's own person. Returns
   * `undefined` when no admitted delivery answers one.
   */
  async takeInputResponses(
    requestIds: ReadonlySet<string>,
  ): Promise<DeliverHookPayload | undefined> {
    for (const sequence of this.admitted) {
      let delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) continue;
      const responses = delivery.payloads.flatMap((payload) => payload.inputResponses ?? []);
      if (responses.length === 0) continue;
      if (!responses.some((response) => requestIds.has(response.requestId))) {
        // Some channels answer with ids only their `deliver` hook resolves,
        // such as Telegram's compact button callbacks.
        if (this.mappedForHeldRequest.has(sequence)) continue;
        this.mappedForHeldRequest.add(sequence);
        const mapped = await mapHeldInputResponses(this.input.cursor, delivery, requestIds);
        if (mapped === undefined) continue;
        delivery = mapped;
      }
      this.admitted.delete(sequence);
      this.input.queue.replaceDelivery(sequence, undefined);
      return delivery;
    }
    return undefined;
  }

  /** Resolves with the id of the call whose timer won, or `undefined` once inbox input is ready. */
  private async waitForInboxOrTimer(
    timers: readonly Promise<string>[],
  ): Promise<string | undefined> {
    if (timers.length === 0 || this.input.inbox.hasPending()) return undefined;
    const inboxReady = this.input.inbox.whenPending().then(() => undefined);
    return await Promise.race([inboxReady, ...timers]);
  }

  private cancelsThisTurn(payload: SessionInboxPayload): boolean {
    if (payload.kind === "reset") return true;
    if (payload.kind !== "cancel") return false;
    return payload.turnId === undefined || payload.turnId === this.expectedTurnId;
  }

  /** Admits one payload; returns whether it was a delivery. */
  private async admit(value: SessionInboxPayload): Promise<boolean> {
    const admitted = await admitSessionInboxPayload(value, this.input);
    switch (admitted.kind) {
      case "delivery":
        this.admitted.add(admitted.admission.sequence);
        return true;
      case "runtime-action-result":
        this.runtimeResults.push({
          kind: "runtime-action-result",
          results: admitted.payload.results,
        });
        return false;
      case "workflow":
        this.runtimeResults.push({ kind: "workflow", message: admitted.message });
        return false;
      case "cancel":
        if (this.cancelsThisTurn(value)) this.abort();
        return false;
      case "consumed":
        return false;
    }
  }

  /**
   * Returns whether a delivery admitted since the last check steers: its
   * message is for the model.
   */
  private checkAdmittedSteering(): boolean {
    let steered = false;
    for (const sequence of this.admitted) {
      if (this.inspected.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      this.inspected.add(sequence);
      if (isSteeringMessage(delivery, this.identity)) steered = true;
    }
    return steered;
  }

  private abort(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new TurnCancelledError());
  }
}

function asBoundaryMessage(event: RuntimeEvent): WorkflowToolRunMessage | undefined {
  if (event === "cancelled" || event.kind !== "workflow") return undefined;
  // Tasks run beside the turn, so everything their runs send, such as a
  // question, reaches the session at the next boundary rather than at turn end.
  if (event.message.from.taskId !== undefined) return event.message;
  // An `execute` run can open a session after its call returns, when the turn
  // may have no wait left to take the message, and publishing it needs none.
  if (event.message.kind === "agent-started") return event.message;
  return undefined;
}
