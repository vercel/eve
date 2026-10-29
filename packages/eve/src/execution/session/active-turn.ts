import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { ControlOrigin } from "#execution/session/input-queue.js";
import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import { mapHeldAnswersStep } from "#execution/proxied-deliver-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import {
  isSteeringDelivery,
  isSteeringMessage,
  type SteeringOptions,
  type SteeringTurn,
} from "#execution/session/input-queue.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import type { SessionExecutionInput } from "#execution/session/turn.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import type { SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import {
  isAgentSessionMessage,
  runMessageBatchBudget,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import {
  isAppliedRunMessage,
  takeLeadingAppliedRunMessages,
} from "#execution/session-workflow-tool-run.js";
import type { AppliedRunMessage } from "#execution/tools/workflow/apply-run-messages-step.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { activeTurnId, storedProjection, turnPosition } from "#harness/session-machine/view.js";
import { coalesceDeliveries, selectDeliveryPayloads } from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import { answersDeliveryId } from "#shared/answers-delivery-id.js";

export type RuntimeEvent =
  | { readonly kind: "runtime-action-result"; readonly results: readonly RuntimeActionResult[] }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  /** A steering message that answered no pending request arrived during the wait. */
  | { readonly kind: "steering" }
  /** An `eve__task_wait` call's timeout passed. */
  | { readonly kind: "timeout"; readonly callId: string }
  /** A delivery or sign-in callback was admitted; a paused turn's request may be answered. */
  | { readonly kind: "input" }
  | "cancelled";

/**
 * Admission policy, cancellation, and steering for one active turn.
 * Deliveries admitted while a model step runs stay in the shared queue until
 * the turn reaches a committed boundary; a runtime-action wait routes them
 * eagerly so a proxied child can receive the answer it is blocked on.
 *
 * The pump signals cancellation and eligible steering immediately. Cancellation
 * aborts the turn; steering only interrupts generation before assistant output
 * or local tool execution. Both retain ordered admission at the next boundary.
 */
export class ActiveTurn {
  private readonly admitted = new Set<number>();
  private readonly routedToChildren = new Set<number>();
  private readonly mappedForHeldRequest = new Set<number>();
  private readonly runtimeResults: RuntimeEvent[] = [];
  private readonly controller: AbortController;
  /** The cancel control that stopped this turn, when it named its delivery. */
  #cancelledBy: ControlOrigin | undefined;
  readonly #control: boolean;
  private readonly expectedTurnId: string;
  private readonly input: SessionExecutionInput;
  /** Who alone steers the turn: its principal, or its delegated caller. */
  private readonly identity: SteeringTurn;
  private readonly unsubscribe: () => void;
  private unsubscribeDelivery: () => void;
  private steeringController: AbortController;
  /** The delegated caller of the latest message the turn read. */
  caller: TurnCaller | undefined;
  /** A step of this turn compacted the history. */
  compacted = false;

  constructor(
    input: SessionExecutionInput,
    owner: {
      readonly caller: TurnCaller | undefined;
      /** A clear or a compact runs, not a turn: a cancel, which stops turns, leaves it to finish. */
      readonly control?: boolean;
      readonly principal: string;
    },
    control: TurnControl = createTurnControl(),
  ) {
    this.controller = control.cancellation;
    this.steeringController = control.steering;
    this.input = input;
    this.caller = owner.caller;
    this.#control = owner.control === true;
    this.identity = { callerCallId: owner.caller?.callId, principal: owner.principal };
    this.expectedTurnId = activeTurnId(
      turnPosition(storedProjection(readDurableSession(input.cursor.sessionState).state)),
    );
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
    if (
      delivery.kind === "deliver" &&
      !this.input.queue.isDuplicate(delivery) &&
      isSteeringMessage(delivery, this.identity) &&
      !this.input.cursor.sessionState.hasProxyInputRequests
    )
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
  async admitBoundary(settled = false): Promise<void> {
    const pending = this.input.inbox.drain();
    for (const payload of pending) await this.admit(payload, settled);
  }

  /**
   * Steering admitted during this turn, routed to children first and coalesced.
   * The next step reads it as input, so its signal must not interrupt that
   * step; only deliveries still unread re-signal the next generation.
   */
  async takeSteering(options?: SteeringOptions): Promise<DeliverHookPayload | undefined> {
    const steering: DeliverHookPayload[] = [];
    while (true) {
      const selection = this.input.queue.takeSteering(this.admitted, this.identity, options);
      if (selection === undefined) break;
      for (const sequence of selection.sequences) this.admitted.delete(sequence);
      const routed = await routeSelectedDelivery(selection, this.input.cursor);
      if (routed.kind === "cancel-turn") {
        this.abort();
        break;
      }
      if (routed.kind === "turn") steering.push(routed.delivery);
    }
    this.resetSteering();
    if (steering.length === 0) return undefined;
    const delivery = steering.length === 1 ? steering[0]! : coalesceDeliveries(steering);
    if (delivery.caller !== undefined) this.caller = delivery.caller;
    return delivery;
  }

  /**
   * Removes the admitted run messages the session applies at once instead of
   * in a runtime wait, or only those `only` accepts.
   */
  takeBoundaryMessages(
    only?: (message: WorkflowToolRunMessage) => boolean,
  ): WorkflowToolRunMessage[] {
    const taken: WorkflowToolRunMessage[] = [];
    const kept: RuntimeEvent[] = [];
    for (const event of this.runtimeResults) {
      const message = asBoundaryMessage(event);
      if (message === undefined || (only !== undefined && !only(message))) kept.push(event);
      else taken.push(message);
    }
    this.runtimeResults.splice(0, this.runtimeResults.length, ...kept);
    return taken;
  }

  /**
   * Removes the run messages read after one the session just took, as long as
   * each is one it applies as it reads it and they fit one batch. Those it
   * already admitted come first, then those still in the inbox, so arrival
   * order holds.
   */
  takeAppliedRunMessages(): AppliedRunMessage[] {
    const admits = runMessageBatchBudget();
    const taken: AppliedRunMessage[] = [];
    for (let next = this.runtimeResults[0]; next !== undefined; next = this.runtimeResults[0]) {
      if (
        next === "cancelled" ||
        next.kind !== "workflow" ||
        !isAppliedRunMessage(next.message) ||
        !admits(next.message)
      )
        return taken;
      taken.push(next.message);
      this.runtimeResults.shift();
    }
    return [...taken, ...takeLeadingAppliedRunMessages(this.input.inbox, admits)];
  }

  /**
   * Next runtime result, workflow message, steering, or timeout, admitting
   * inbox traffic while waiting. Deliveries admitted before the wait began are
   * routed first, so a message that arrived as the calls started still steers.
   * `timers` are durable sleeps raced against the inbox.
   */
  async nextRuntimeEvent(timers: readonly Promise<string>[]): Promise<RuntimeEvent> {
    while (true) {
      const steered = await this.routeAdmittedToChildren();
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
   * Takes one admitted delivery that answers a pending input request, from any
   * responder: an approver need not be the turn's own person. Returns
   * `undefined` when no admitted delivery answers one.
   */
  async takeAnswers(requestIds: ReadonlySet<string>): Promise<DeliverHookPayload | undefined> {
    for (const sequence of this.admitted) {
      let delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) continue;
      const responses = delivery.payloads.flatMap((payload) => payload.answers ?? []);
      if (responses.length === 0) continue;
      if (!responses.some((response) => requestIds.has(response.interactionId))) {
        // Some channels answer with ids only their `deliver` hook resolves,
        // such as Telegram's compact button callbacks.
        if (this.mappedForHeldRequest.has(sequence)) continue;
        this.mappedForHeldRequest.add(sequence);
        const target = delivery;
        const mapped = await this.input.cursor.advance((state) =>
          mapHeldAnswersStep({ delivery: target, requestIds: [...requestIds], ...state }),
        );
        if (mapped.delivery === undefined) continue;
        delivery = mapped.delivery;
      }
      this.admitted.delete(sequence);
      // Someone else's answers settle the paused turn's request, but the rest of their
      // delivery waits for the turn to end, as their messages do.
      const split = isSteeringDelivery(delivery, this.identity, { heldOnPerson: true })
        ? undefined
        : splitAnswers(delivery);
      this.input.queue.replaceDelivery(sequence, split?.rest);
      return split?.answers ?? delivery;
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
    if (payload.kind === "reset" || payload.kind === "session-failure") return true;
    if (payload.kind !== "cancel" || this.#control) return false;
    return payload.turnId === undefined || payload.turnId === this.expectedTurnId;
  }

  /** Admits one payload; returns whether it was a delivery or sign-in callback. */
  private async admit(value: SessionInboxPayload, settled = false): Promise<boolean> {
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
        if (
          (!settled || value.kind !== "cancel") &&
          this.cancelsThisTurn(value) &&
          this.#cancelledBy === undefined
        ) {
          this.#cancelledBy ??= admitted.origin;
          this.abort();
        } else if (admitted.origin !== undefined) {
          const control = controlDeliveryOf(admitted.origin);
          await this.input.cursor.advance((state) =>
            settleControlDeliveryStep({
              ...state,
              settlement: { control, outcome: "ignored", source: "cancel" },
            }),
          );
        }
        return false;
      case "consumed":
        return value.kind === "authorization-callback";
    }
  }

  /**
   * During a runtime wait, descendant-bound answers cannot wait for the
   * boundary. Returns whether a newly routed delivery still steers: it
   * answered nothing, so its message is for the model.
   */
  private async routeAdmittedToChildren(): Promise<boolean> {
    let steered = false;
    for (const sequence of this.admitted) {
      if (this.routedToChildren.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      this.routedToChildren.add(sequence);
      const routed = await this.input.cursor.advance((state) =>
        routeDeliverToChildren({ delivery, ...state }),
      );
      if (routed.kind === "cancel-turn") {
        this.input.queue.replaceDelivery(sequence, undefined);
        this.admitted.delete(sequence);
        this.abort();
        return false;
      }
      this.input.queue.replaceDelivery(sequence, routed.remainder);
      if (routed.remainder === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      if (isSteeringMessage(routed.remainder, this.identity)) steered = true;
    }
    return steered;
  }

  /** The cancel control that stopped this turn, when it named its delivery. */
  get cancelledBy(): ControlOrigin | undefined {
    return this.#cancelledBy;
  }

  /** Also used by hooks on workflow reports while the turn waits. */
  abort(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new TurnCancelledError());
  }
}

function asBoundaryMessage(event: RuntimeEvent): WorkflowToolRunMessage | undefined {
  if (event === "cancelled" || event.kind !== "workflow") return undefined;
  // Tasks run beside the turn, so everything their runs send, such as a
  // question, reaches the session at the next boundary rather than at turn end.
  if (event.message.from.taskId !== undefined) return event.message;
  // An `execute` run can open or message a session after its call returns, when
  // the turn may have no wait left to take the message, and publishing it needs none.
  if (isAgentSessionMessage(event.message)) return event.message;
  return undefined;
}

function splitAnswers(delivery: DeliverHookPayload): {
  readonly answers: DeliverHookPayload;
  readonly rest: DeliverHookPayload | undefined;
} {
  const answers = delivery.payloads.flatMap((payload, index) =>
    payload.answers === undefined ? [] : [{ index, payload: { answers: payload.answers } }],
  );
  // Only a message waits for the turn to end. What else a press carries, such as a channel's
  // state, has nothing left to deliver; queued, it would come back as a delivery the session
  // already settled.
  const rest = delivery.payloads.flatMap((payload, index) => {
    if (payload.message === undefined) return [];
    const { answers: _answers, ...other } = payload;
    return [{ index, payload: other }];
  });
  const selectedAnswers = selectDeliveryPayloads(delivery, answers);
  const messageIndices = new Set(rest.map(({ index }) => index));
  return {
    answers: {
      ...selectedAnswers,
      deliveryMetadata: selectedAnswers.deliveryMetadata?.map((entry) => ({
        ...entry,
        deliveryId: messageIndices.has(answers[entry.payloadIndex]!.index)
          ? answersDeliveryId(entry.deliveryId)
          : entry.deliveryId,
      })),
    },
    rest: rest.length === 0 ? undefined : selectDeliveryPayloads(delivery, rest),
  };
}
