import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { coalesceDeliveries } from "#harness/messages.js";
import type { SessionStateMap } from "#harness/types.js";
import { jsonValuesEqual } from "#shared/json.js";
import { sameTaskPrincipal } from "#tasks/results.js";

/** How many admitted operations a session remembers; a resend older than that is admitted again. */
export const MAX_ADMITTED_OPERATIONS = 256;

/** Session state key a session hands its admitted operations to its successor under. */
export const ADMITTED_OPERATIONS_STATE_KEY = "eve.admittedOperations";

/** The admitted operations a predecessor handed this session, oldest first. */
export function readAdmittedOperations(state: SessionStateMap | undefined): readonly string[] {
  const value = state?.[ADMITTED_OPERATIONS_STATE_KEY];
  return Array.isArray(value)
    ? value.filter((key): key is string => typeof key === "string").slice(-MAX_ADMITTED_OPERATIONS)
    : [];
}

/**
 * Records the admitted operations in the session state a successor starts
 * from. It runs in the workflow body, so it edits the snapshot directly
 * rather than through the session store, which the body must not import.
 */
export function withAdmittedOperations(
  sessionState: DurableSessionState,
  keys: readonly string[],
): DurableSessionState {
  const { session } = sessionState.snapshot;
  return {
    ...sessionState,
    snapshot: {
      ...sessionState.snapshot,
      session: {
        ...session,
        state: { ...session.state, [ADMITTED_OPERATIONS_STATE_KEY]: [...keys] },
      },
    },
  };
}

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

/** Whose deliveries may steer a turn. */
export interface SteerableTurn {
  /** The delegated call the session is answering, whose owner's messages steer it. */
  readonly callerCallId: string | undefined;
  /** The principal the turn acts for. */
  readonly principal: SessionAuthContext | null;
}

/**
 * Ordered, admitted session input. Entries are private; callers receive typed
 * admission and selection values. Everything here is rebuilt deterministically
 * on replay.
 */
export class SessionInputQueue {
  private readonly entries: QueuedSessionInput[] = [];
  private nextSequence = 0;
  /**
   * The most recent operations admitted, per principal and oldest first, so a
   * resent delivery is dropped. A successor starts from its predecessor's.
   */
  private readonly operations: string[];
  /** Steering messages admitted per delegated call since the session last answered it. */
  private readonly steerCounts = new Map<string, number>();

  constructor(options: { readonly admittedOperations?: readonly string[] } = {}) {
    this.operations = [...(options.admittedOperations ?? [])];
  }

  get pendingCount(): number {
    return this.entries.length;
  }

  /** The operations this session remembers, to hand to a successor. */
  admittedOperations(): readonly string[] {
    return [...this.operations];
  }

  /**
   * Admits a delivery. A delivery with an `operationId` is admitted once per
   * principal; a repeat, such as one resent by a retried owner step, returns
   * `undefined`. Two principals may use the same `operationId`.
   */
  enqueueDelivery(delivery: DeliverHookPayload): DeliveryAdmission | undefined {
    const key = operationKey(delivery);
    if (key !== undefined) {
      if (this.operations.includes(key)) return undefined;
      this.operations.push(key);
      if (this.operations.length > MAX_ADMITTED_OPERATIONS) this.operations.shift();
      const callId = delivery.caller?.callId;
      if (callId !== undefined && isOwnerSteer(delivery))
        this.steerCounts.set(callId, (this.steerCounts.get(callId) ?? 0) + 1);
    }
    const admission = { delivery, sequence: this.nextSequence++ };
    this.entries.push({ ...admission, kind: "delivery" });
    return admission;
  }

  /**
   * Steering messages admitted for a delegated call since the last answer,
   * reported with the answer that settles the call. Every one of them
   * reached that answer: a steering message waiting in the queue holds the
   * answer (see {@link hasSteeringMessage}), and one admitted afterwards
   * starts the call's next turn and counts toward that turn's answer.
   */
  takeSteerCount(callId: string): number {
    const count = this.steerCounts.get(callId) ?? 0;
    this.steerCounts.delete(callId);
    return count;
  }

  /** Drops a cancelled call's waiting steering messages, so they do not start work nobody receives. */
  discardSteering(callId: string): void {
    this.steerCounts.delete(callId);
    this.retain(
      (entry) =>
        entry.kind !== "delivery" ||
        !isOwnerSteer(entry.delivery) ||
        entry.delivery.caller?.callId !== callId,
    );
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

  /**
   * Whether a steering message for `turn` waits in the queue. A delegated
   * session that finds one as its turn ends runs it for the same caller
   * before replying.
   */
  hasSteeringMessage(turn: SteerableTurn): boolean {
    return this.entries.some(
      (entry) =>
        entry.kind === "delivery" &&
        isSteeringDelivery(entry.delivery, turn) &&
        entry.delivery.payloads.some((payload) => payload.message !== undefined),
    );
  }

  /**
   * Takes the admitted deliveries that steer `turn`, in order. Every other
   * delivery stays queued, in order, until the turn ends.
   */
  takeSteering(admitted: ReadonlySet<number>, turn: SteerableTurn): TurnSelection | undefined {
    const steering = this.entries.filter(
      (entry): entry is QueuedDelivery =>
        entry.kind === "delivery" &&
        admitted.has(entry.sequence) &&
        isSteeringDelivery(entry.delivery, turn),
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
    readonly deferDeliveries?: boolean;
    /**
     * Attempt ids of the open authorization challenge. Callbacks for other
     * attempts are stale and dropped; once every expected attempt has
     * reported, the collected payloads resume the challenge ahead of
     * ordinary input.
     */
    readonly expectedAttemptIds?: ReadonlySet<string>;
    /** Sequence of a delivery admitted while nothing else was pending. */
    readonly freshSequence?: number;
  }): SessionInputSelection | undefined {
    const expected = options?.expectedAttemptIds ?? new Set<string>();
    this.retain((entry) => entry.kind !== "authorization" || expected.has(entry.attemptId));
    if (expected.size > 0) {
      const collected = new Map(
        this.entries.flatMap((entry) =>
          entry.kind === "authorization" ? [[entry.attemptId, entry.payload] as const] : [],
        ),
      );
      if ([...expected].every((attemptId) => collected.has(attemptId))) {
        this.retain((entry) => entry.kind !== "authorization");
        return {
          kind: "authorization-resume",
          payloads: [...expected].map((attemptId) => collected.get(attemptId)!),
        };
      }
    }
    const deferDeliveries = options?.deferDeliveries === true;
    const index = this.entries.findIndex(
      (entry) => entry.kind === "control" || (entry.kind === "delivery" && !deferDeliveries),
    );
    if (index < 0) return undefined;
    return this.takeSelectionAt(index, options?.freshSequence);
  }

  private takeSelectionAt(index: number, freshSequence: number | undefined): SessionInputSelection {
    const first = this.entries.splice(index, 1)[0]!;
    if (first.kind === "control") return { control: first.control, kind: "control" };
    if (first.kind === "authorization") {
      return { kind: "authorization-resume", payloads: [first.payload] };
    }
    const turnEntries = [first];
    const authenticated =
      first.delivery.auth != null && first.delivery.auth.principalType !== "anonymous";
    let caller = first.delivery.caller;
    while (this.entries.length > index) {
      const next = this.entries[index];
      // A turn runs with its principal's auth (G4), so only one principal's
      // deliveries may share it, and only an authenticated one: anonymous
      // callers cannot be told apart.
      if (
        next?.kind !== "delivery" ||
        !authenticated ||
        !jsonValuesEqual(first.delivery.auth, next.delivery.auth) ||
        (caller !== undefined && next.delivery.caller !== undefined)
      ) {
        break;
      }
      turnEntries.push(this.entries.splice(index, 1)[0] as QueuedDelivery);
      caller ??= next.delivery.caller;
    }

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

  private retain(predicate: (entry: QueuedSessionInput) => boolean): void {
    const kept = this.entries.filter(predicate);
    this.entries.splice(0, this.entries.length, ...kept);
  }
}

/**
 * Whether a delivery steers `turn` rather than waiting for it to end. Only
 * the turn's own principal can steer it: a turn runs with its principal's
 * auth, and would otherwise act for the wrong person (G4). Anonymous callers
 * share one principal. A delivery without `auth` keeps the session's
 * principal, as an owner's message to its delegated call does.
 */
export function isSteeringDelivery(delivery: DeliverHookPayload, turn: SteerableTurn): boolean {
  return (
    (delivery.turnPolicy ?? "steer") === "steer" &&
    (delivery.caller === undefined || delivery.caller.callId === turn.callerCallId) &&
    (delivery.auth === undefined || sameTaskPrincipal(delivery.auth, turn.principal))
  );
}

/** A delivery's operation identity, scoped to the principal that sent it. */
function operationKey(delivery: DeliverHookPayload): string | undefined {
  if (delivery.operationId === undefined) return undefined;
  const auth = delivery.auth ?? null;
  return JSON.stringify([
    auth?.authenticator ?? null,
    auth?.issuer ?? null,
    auth?.principalType ?? null,
    auth?.principalId ?? null,
    delivery.operationId,
  ]);
}

/**
 * An owner's steering message for its delegated call: keyed, addressed to the
 * call, and steering. An owner starts a call's next turn with `queue`.
 */
function isOwnerSteer(delivery: DeliverHookPayload): boolean {
  return (
    delivery.operationId !== undefined &&
    delivery.caller !== undefined &&
    (delivery.turnPolicy ?? "steer") === "steer"
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
