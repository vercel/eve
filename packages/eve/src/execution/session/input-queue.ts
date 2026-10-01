import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
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

interface QueuedAuthorization {
  readonly attemptId: string;
  readonly kind: "authorization";
  readonly payload: DeliverPayload;
  readonly sequence: number;
}

type QueuedSessionInput = QueuedDelivery | QueuedControl | QueuedAuthorization;

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
  | { readonly control: SessionControl; readonly kind: "control" }
  | { readonly kind: "authorization-resume"; readonly payloads: readonly DeliverPayload[] };

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

  /** Keeps one payload per authorization attempt; a repeated callback for the same attempt is dropped. */
  enqueueAuthorization(payloads: readonly DeliverPayload[]): void {
    for (const payload of payloads) {
      const attemptId = authorizationAttemptId(payload);
      if (attemptId === undefined) continue;
      if (
        this.entries.some(
          (entry) => entry.kind === "authorization" && entry.attemptId === attemptId,
        )
      )
        continue;
      this.entries.push({
        attemptId,
        kind: "authorization",
        payload,
        sequence: this.nextSequence++,
      });
    }
  }

  /**
   * Removes and returns the queued callbacks for `attemptIds` once every one
   * has arrived, so a turn holding several sign-ins resumes when all are done.
   */
  takeAuthorizations(attemptIds: ReadonlySet<string>): DeliverPayload[] | undefined {
    const taken = this.entries.filter(
      (entry): entry is QueuedAuthorization =>
        entry.kind === "authorization" && attemptIds.has(entry.attemptId),
    );
    if (
      taken.length === 0 ||
      new Set(taken.map((entry) => entry.attemptId)).size < attemptIds.size
    ) {
      return undefined;
    }
    this.retain((entry) => !taken.includes(entry as QueuedAuthorization));
    return taken.map((entry) => entry.payload);
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

  takeNext(options?: {
    /**
     * Attempt ids of the open authorization challenges. Callbacks for other
     * attempts are stale and dropped. Any expected callback resumes ahead of
     * ordinary input; the other challenges stay pending. Waiting for every
     * attempt would let one ignored sign-in prompt, possibly from an earlier
     * turn, keep a completed sign-in from ever resuming the session.
     */
    readonly expectedAttemptIds?: ReadonlySet<string>;
    /** Sequence of a delivery admitted while nothing else was pending. */
    readonly freshSequence?: number;
  }): SessionInputSelection | undefined {
    const expected = options?.expectedAttemptIds ?? new Set<string>();
    this.retain((entry) => entry.kind !== "authorization" || expected.has(entry.attemptId));
    const payloads = this.entries.flatMap((entry) =>
      entry.kind === "authorization" ? [entry.payload] : [],
    );
    if (payloads.length > 0) {
      this.retain((entry) => entry.kind !== "authorization");
      return { kind: "authorization-resume", payloads };
    }
    const index = this.entries.findIndex((entry) => entry.kind !== "authorization");
    if (index < 0) return undefined;
    return this.takeSelectionAt(index, options?.freshSequence);
  }

  private takeSelectionAt(index: number, freshSequence: number | undefined): SessionInputSelection {
    const first = this.entries.splice(index, 1)[0]!;
    if (first.kind === "control") return { control: first.control, kind: "control" };
    if (first.kind === "authorization") {
      return { kind: "authorization-resume", payloads: [first.payload] };
    }

    const turnEntries = [first, ...this.takeFollowingDeliveriesFrom(first, index)];
    const sequences = turnEntries.map(({ sequence }) => sequence);
    const combined = combine(turnEntries);
    return {
      delivery: combined,
      handoffEligible:
        sequences.length === 1 &&
        sequences[0] === freshSequence &&
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
  private takeFollowingDeliveriesFrom(first: QueuedDelivery, index: number): QueuedDelivery[] {
    const principal = principalOf(first.delivery.auth);
    const following: QueuedDelivery[] = [];
    let callId = first.delivery.caller?.callId;
    while (this.entries.length > index) {
      const next = this.entries[index];
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
      following.push(this.entries.splice(index, 1)[0] as QueuedDelivery);
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
   * The turn waits on its own person for a sign-in or approval. Their message
   * steers even with `turnPolicy: "queue"`: queued, it would wait for a turn
   * that cannot end until they act.
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

function authorizationAttemptId(payload: DeliverPayload): string | undefined {
  const callback = payload["authorizationCallback"] as { readonly attemptId?: unknown } | undefined;
  return typeof callback?.attemptId === "string" ? callback.attemptId : undefined;
}
