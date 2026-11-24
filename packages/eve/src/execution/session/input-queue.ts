import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { DELIVERY_IDEMPOTENCY_WINDOW } from "#channel/delivery-idempotency.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { ANONYMOUS_PRINCIPAL, principalOf } from "#execution/session/principal.js";

export type SessionControl = "clear" | "compact" | "expired" | "reset";

export interface ControlOrigin {
  readonly deliveryId: string;
  readonly auth?: SessionAuthContext | null;
}

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
  readonly origin?: ControlOrigin;
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
  readonly handoffEligible: boolean;
  readonly kind: "turn";
  readonly sequences: readonly number[];
}

export type SessionInputSelection =
  | TurnSelection
  | { readonly control: SessionControl; readonly kind: "control"; readonly origin?: ControlOrigin };

export interface QueueHold {
  readonly at: number;
  timer?: Promise<void>;
}

export class SessionInputQueue {
  private readonly entries: QueuedSessionInput[] = [];
  private hold: QueueHold | undefined;
  private readonly admittedKeys: Set<string>;
  private nextSequence = 0;
  private prewarmDeploymentId: string | undefined;

  prepareOnDeployment(deploymentId: string): void {
    this.prewarmDeploymentId = deploymentId;
  }
  takePrewarmDeployment(): string | undefined {
    const target = this.prewarmDeploymentId;
    this.prewarmDeploymentId = undefined;
    return target;
  }

  constructor(admittedDeliveryKeys: readonly string[]) {
    this.admittedKeys = new Set(admittedDeliveryKeys);
  }

  get admittedDeliveryKeys(): readonly string[] {
    return [...this.admittedKeys];
  }

  isDuplicate(delivery: DeliverHookPayload): boolean {
    return delivery.idempotencyKey !== undefined && this.admittedKeys.has(delivery.idempotencyKey);
  }

  get pendingCount(): number {
    return this.entries.length;
  }

  get nextAdmission(): number {
    return this.nextSequence;
  }

  enqueueDelivery(delivery: DeliverHookPayload): DeliveryAdmission | undefined {
    if (this.isDuplicate(delivery)) return undefined;
    if (delivery.idempotencyKey !== undefined) {
      this.admittedKeys.add(delivery.idempotencyKey);
      if (this.admittedKeys.size > DELIVERY_IDEMPOTENCY_WINDOW) {
        this.admittedKeys.delete(this.admittedKeys.values().next().value!);
      }
    }
    this.prewarmDeploymentId = undefined;
    const admission = { delivery, sequence: this.nextSequence++ };
    this.entries.push({ ...admission, kind: "delivery" });
    return admission;
  }

  enqueueControl(control: SessionControl, origin?: ControlOrigin): void {
    const entry: { -readonly [K in keyof QueuedControl]: QueuedControl[K] } = {
      control,
      kind: "control",
      sequence: this.nextSequence++,
    };
    if (origin !== undefined) entry.origin = origin;
    this.entries.push(entry);
  }

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
    const eligible = this.entries.filter(
      (entry): entry is QueuedDelivery =>
        entry.kind === "delivery" &&
        admitted.has(entry.sequence) &&
        isSteeringDelivery(entry.delivery, turn, {
          heldOnPerson: options?.heldSince !== undefined && entry.sequence >= options.heldSince,
          paused: options?.paused,
        }),
    );
    const senderOf = ({ delivery }: QueuedDelivery) =>
      delivery.auth === undefined ? turn.principal : principalOf(delivery.auth);
    const first = eligible[0];
    if (first === undefined) return undefined;
    const end = eligible.findIndex((entry) => senderOf(entry) !== senderOf(first));
    const steering = end === -1 ? eligible : eligible.slice(0, end);
    this.retain((entry) => entry.kind !== "delivery" || !steering.includes(entry));
    return {
      delivery: combine(steering),
      handoffEligible: false,
      kind: "turn",
      sequences: steering.map(({ sequence }) => sequence),
    };
  }

  beginHold(at: number): void {
    this.hold = { at };
  }

  endHold(): void {
    this.hold = undefined;
  }

  activeHold(): QueueHold | undefined {
    const queuedOnly = this.entries.every(
      (entry) =>
        entry.kind === "authorization" ||
        (entry.kind === "delivery" &&
          entry.delivery.turnPolicy === "queue" &&
          entry.delivery.caller === undefined),
    );
    return queuedOnly ? this.hold : undefined;
  }

  takeNext(options?: { readonly freshSequence?: number }): SessionInputSelection | undefined {
    this.hold = undefined;
    this.retain((entry) => entry.kind !== "authorization");
    const first = this.entries.shift() as QueuedDelivery | QueuedControl | undefined;
    if (first === undefined) return undefined;
    if (first.kind === "control")
      return first.origin === undefined
        ? { control: first.control, kind: "control" }
        : { control: first.control, kind: "control", origin: first.origin };

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

export interface SteeringTurn {
  readonly callerCallId: string | undefined;
  readonly principal: string;
}

export interface SteeringOptions {
  readonly heldSince?: number;
  readonly paused?: boolean;
}

export function isSteeringDelivery(
  delivery: DeliverHookPayload,
  turn: SteeringTurn,
  options?: { readonly heldOnPerson?: boolean; readonly paused?: boolean },
): boolean {
  const paused = options?.paused === true || options?.heldOnPerson === true;
  return (
    (options?.heldOnPerson === true || (delivery.turnPolicy ?? "steer") === "steer") &&
    (delivery.caller === undefined || delivery.caller.callId === turn.callerCallId) &&
    (delivery.auth === undefined ||
      principalOf(delivery.auth) === turn.principal ||
      (!paused && joinsAnotherTurn(delivery)))
  );
}

function joinsAnotherTurn(delivery: DeliverHookPayload): boolean {
  return (
    delivery.principalPolicy === "retain" &&
    delivery.auth != null &&
    principalOf(delivery.auth) !== ANONYMOUS_PRINCIPAL
  );
}

export function isSteeringMessage(
  delivery: DeliverHookPayload,
  turn: SteeringTurn,
  options?: { readonly paused?: boolean },
): boolean {
  return (
    isSteeringDelivery(delivery, turn, options) &&
    delivery.payloads.some(
      (payload) => payload.message !== undefined && payload.answers === undefined,
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
