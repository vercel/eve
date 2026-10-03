import type { DeliverHookPayload } from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { ANONYMOUS_PRINCIPAL, principalOf } from "#execution/session/principal.js";

export type SessionControl = "clear" | "compact" | "expired" | "reset";

export interface DeliveryAdmission {
  readonly delivery: DeliverHookPayload;
  readonly sequence: number;
}

interface QueuedDelivery extends DeliveryAdmission {
  readonly kind: "delivery";
}

interface QueuedControl {
  readonly control: SessionControl;
  readonly kind: "control";
  readonly sequence: number;
}

type QueuedSessionInput = QueuedDelivery | QueuedControl;

export interface TurnSelection {
  readonly delivery: DeliverHookPayload;
  /**
   * True only for a lone, callerless conversational delivery that arrived
   * while nothing else was pending. Such a delivery may move the session to
   * the deployment that accepted it.
   */
  readonly handoffEligible: boolean;
  readonly kind: "turn";
  /** Sequences of every admission folded into this turn. */
  readonly sequences: readonly number[];
}

export type SessionInputSelection =
  | TurnSelection
  | { readonly control: SessionControl; readonly kind: "control" };

/**
 * Ordered, admitted session input. Entries are private; callers receive typed
 * admission and selection values. Everything here is rebuilt deterministically
 * on replay.
 */
export class SessionInputQueue {
  private readonly entries: QueuedSessionInput[] = [];
  private nextSequence = 0;

  get pendingCount(): number {
    return this.entries.length;
  }

  enqueueDelivery(delivery: DeliverHookPayload): DeliveryAdmission {
    const admission = { delivery, sequence: this.nextSequence++ };
    this.entries.push({ ...admission, kind: "delivery" });
    return admission;
  }

  enqueueControl(control: SessionControl): void {
    this.entries.push({ control, kind: "control", sequence: this.nextSequence++ });
  }

  delivery(sequence: number): DeliverHookPayload | undefined {
    const entry = this.entries.find(
      (candidate): candidate is QueuedDelivery =>
        candidate.kind === "delivery" && candidate.sequence === sequence,
    );
    return entry?.delivery;
  }

  replaceDelivery(sequence: number, delivery: DeliverHookPayload | undefined): void {
    const index = this.entries.findIndex(
      (entry) => entry.kind === "delivery" && entry.sequence === sequence,
    );
    if (index < 0) return;
    if (delivery === undefined) {
      this.entries.splice(index, 1);
      return;
    }
    this.entries[index] = { delivery, kind: "delivery", sequence };
  }

  takeSteering(
    admitted: ReadonlySet<number>,
    turn: SteeringTurn,
    options?: SteeringOptions,
  ): TurnSelection | undefined {
    const steering = this.entries.filter(
      (entry): entry is QueuedDelivery =>
        entry.kind === "delivery" &&
        admitted.has(entry.sequence) &&
        isSteeringDelivery(entry.delivery, turn, options),
    );
    if (steering.length === 0) return undefined;
    this.retain((entry) => entry.kind !== "delivery" || !steering.includes(entry));
    return {
      delivery: combine(steering),
      handoffEligible: false,
      kind: "turn",
      sequences: steering.map(({ sequence }) => sequence),
    };
  }

  /** Takes the next turn or control. */
  takeNext(options?: {
    /** Sequence of a delivery admitted while nothing else was pending. */
    readonly freshSequence?: number;
  }): SessionInputSelection | undefined {
    const first = this.entries.shift();
    if (first === undefined) return undefined;
    if (first.kind === "control") return { control: first.control, kind: "control" };

    const turnEntries = [first, ...this.takeFollowingDeliveriesFrom(first)];
    const sequences = turnEntries.map(({ sequence }) => sequence);
    const combined = combine(turnEntries);
    return {
      delivery: combined,
      handoffEligible:
        sequences.length === 1 &&
        sequences[0] === options?.freshSequence &&
        combined.caller === undefined &&
        this.entries.length === 0,
      kind: "turn",
      sequences,
    };
  }

  /**
   * Consecutive deliveries of one authenticated principal and one delegated
   * call share a turn, as they would steer it. Claims may change between
   * them; the turn runs with the latest.
   */
  private takeFollowingDeliveriesFrom(first: QueuedDelivery): QueuedDelivery[] {
    const principal = principalOf(first.delivery.auth);
    const following: QueuedDelivery[] = [];
    let callId = first.delivery.caller?.callId;
    while (true) {
      const next = this.entries[0];
      if (
        next?.kind !== "delivery" ||
        principal === ANONYMOUS_PRINCIPAL ||
        principalOf(next.delivery.auth) !== principal ||
        (callId !== undefined &&
          next.delivery.caller !== undefined &&
          next.delivery.caller.callId !== callId)
      ) {
        break;
      }
      following.push(next);
      this.entries.shift();
      callId ??= next.delivery.caller?.callId;
    }
    return following;
  }

  private retain(predicate: (entry: QueuedSessionInput) => boolean): void {
    const kept = this.entries.filter(predicate);
    this.entries.splice(0, this.entries.length, ...kept);
  }
}

/** The running turn a delivery may steer. */
export interface SteeringTurn {
  /** The call id of the delegated caller the turn answers, if any. */
  readonly callerCallId: string | undefined;
  readonly principal: string;
}

export interface SteeringOptions {
  /**
   * The turn waits on its own person. Their message steers even with
   * `turnPolicy: "queue"`: queued, it would wait for a turn that cannot end
   * until they act.
   */
  readonly heldOnPerson?: boolean;
}

/**
 * Only the turn's own principal steers it; another principal's message waits
 * for the turn to end. A delivery without auth acts as the session's current
 * identity, which is the turn's.
 */
export function isSteeringDelivery(
  delivery: DeliverHookPayload,
  turn: SteeringTurn,
  options?: SteeringOptions,
): boolean {
  return (
    (options?.heldOnPerson === true || (delivery.turnPolicy ?? "steer") === "steer") &&
    (delivery.caller === undefined || delivery.caller.callId === turn.callerCallId) &&
    (delivery.auth === undefined || principalOf(delivery.auth) === turn.principal)
  );
}

/** A steering delivery with a message for the model, not only answers to requests. */
export function isSteeringMessage(delivery: DeliverHookPayload, turn: SteeringTurn): boolean {
  return (
    isSteeringDelivery(delivery, turn) &&
    delivery.payloads.some(
      (payload) => payload.message !== undefined && payload.inputResponses === undefined,
    )
  );
}

function combine(entries: readonly DeliveryAdmission[]): DeliverHookPayload {
  if (entries.length === 1) return entries[0]!.delivery;
  return coalesceDeliveries(entries.map(({ delivery }) => delivery));
}
