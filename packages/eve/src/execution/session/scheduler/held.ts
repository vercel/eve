import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { ANONYMOUS_PRINCIPAL, principalOf } from "#execution/session/principal.js";

/**
 * What the session holds: everything the world sent that no step has taken yet, in arrival
 * order. A value, so each rule here returns the session's holdings after it rather than changing
 * them; the scheduler threads it through. Everything here is rebuilt deterministically on replay.
 */
export interface Held {
  readonly entries: readonly HeldEntry[];
  /** The sequence the next arrival gets; everything held arrived below it. */
  readonly next: number;
  /** Every delivery held below this sequence was routed to the children it answers. */
  readonly routed: number;
}

export type HeldEntry = HeldDelivery | HeldControl | HeldSignIn;

export interface HeldDelivery {
  readonly kind: "delivery";
  readonly sequence: number;
  readonly delivery: DeliverHookPayload;
}

export interface HeldControl {
  readonly kind: "control";
  readonly sequence: number;
  readonly control: SessionControl;
  readonly origin?: ControlOrigin;
}

/** A connection's sign-in callback, which resumes the turn that asked for the sign-in. */
export interface HeldSignIn {
  readonly kind: "sign-in";
  readonly sequence: number;
  readonly attemptId: string;
  readonly payload: DeliverPayload;
}

export type SessionControl = "clear" | "compact" | "expired" | "reset";

/** The delivery a control arrived as: its id, and who sent it. */
export interface ControlOrigin {
  readonly deliveryId: string;
  readonly auth?: SessionAuthContext | null;
}

/** What a turn takes of what's held: deliveries, coalesced into one. */
export interface TurnSelection {
  readonly kind: "turn";
  readonly delivery: DeliverHookPayload;
  /** The sequences of every delivery it took. */
  readonly sequences: readonly number[];
  /**
   * True only for a lone, callerless delivery that arrived while nothing else was held or
   * waiting. Such a delivery may move the session to the deployment that accepted it.
   */
  readonly handoffEligible: boolean;
}

export type Taken =
  | TurnSelection
  | { readonly kind: "control"; readonly control: SessionControl; readonly origin?: ControlOrigin };

/** The turn a delivery may steer. */
export interface SteeringTurn {
  /** The call id of the delegated caller the turn answers, if any. */
  readonly callerCallId: string | undefined;
  readonly principal: string;
}

export const NOTHING_HELD: Held = { entries: [], next: 0, routed: 0 };

export function holdDelivery(
  held: Held,
  delivery: DeliverHookPayload,
): { readonly held: Held; readonly sequence: number } {
  const sequence = held.next;
  return { held: append(held, { delivery, kind: "delivery", sequence }), sequence };
}

export function holdControl(held: Held, control: SessionControl, origin?: ControlOrigin): Held {
  const entry: HeldControl =
    origin === undefined
      ? { control, kind: "control", sequence: held.next }
      : { control, kind: "control", origin, sequence: held.next };
  return append(held, entry);
}

/** Holds one callback per sign-in attempt; a repeated callback for the same attempt is dropped. */
export function holdSignIns(held: Held, payloads: readonly DeliverPayload[]): Held {
  return payloads.reduce((current, payload) => {
    const attemptId = signInAttemptId(payload);
    if (attemptId === undefined) return current;
    if (current.entries.some((entry) => entry.kind === "sign-in" && entry.attemptId === attemptId))
      return current;
    return append(current, { attemptId, kind: "sign-in", payload, sequence: current.next });
  }, held);
}

/**
 * The callbacks for `attemptIds`, once every one has arrived, so a turn holding several sign-ins
 * resumes when all are done.
 */
export function takeSignIns(
  held: Held,
  attemptIds: ReadonlySet<string>,
): { readonly held: Held; readonly payloads?: readonly DeliverPayload[] } {
  const taken = held.entries.filter(
    (entry): entry is HeldSignIn => entry.kind === "sign-in" && attemptIds.has(entry.attemptId),
  );
  if (taken.length === 0 || new Set(taken.map((entry) => entry.attemptId)).size < attemptIds.size)
    return { held };
  return {
    held: retain(held, (entry) => !taken.includes(entry as HeldSignIn)),
    payloads: taken.map((entry) => entry.payload),
  };
}

export function heldDelivery(held: Held, sequence: number): DeliverHookPayload | undefined {
  return held.entries.find(
    (entry): entry is HeldDelivery => entry.kind === "delivery" && entry.sequence === sequence,
  )?.delivery;
}

/** Every delivery held, in arrival order. */
export function heldDeliveries(held: Held): readonly DeliverHookPayload[] {
  return held.entries.flatMap((entry) => (entry.kind === "delivery" ? [entry.delivery] : []));
}

/** Every control held that arrived as a delivery, in arrival order. */
export function heldControls(
  held: Held,
): readonly { readonly control: SessionControl; readonly origin: ControlOrigin }[] {
  return held.entries.flatMap((entry) =>
    entry.kind === "control" && entry.origin !== undefined
      ? [{ control: entry.control, origin: entry.origin }]
      : [],
  );
}

/** What's left of the delivery at `sequence`: `undefined` takes it away. */
export function replaceDelivery(
  held: Held,
  sequence: number,
  delivery: DeliverHookPayload | undefined,
): Held {
  const entries = held.entries.flatMap((entry): HeldEntry[] => {
    if (entry.kind !== "delivery" || entry.sequence !== sequence) return [entry];
    return delivery === undefined ? [] : [{ delivery, kind: "delivery", sequence }];
  });
  return { ...held, entries };
}

/**
 * The turn's own deliveries that steer it, among those it admitted, coalesced. A turn that waits
 * on its own person, held since `heldSince`, also takes their later messages that only queue
 * (`turnPolicy: "queue"`): queued, they would wait for a turn that can't end until they act.
 * Earlier ones were sent before the request existed, so they stay held, and never answer it.
 */
export function takeSteering(
  held: Held,
  admitted: readonly number[],
  turn: SteeringTurn,
  heldSince?: number,
): { readonly held: Held; readonly selection?: TurnSelection } {
  const steering = held.entries.filter(
    (entry): entry is HeldDelivery =>
      entry.kind === "delivery" &&
      admitted.includes(entry.sequence) &&
      isSteeringDelivery(entry.delivery, turn, {
        heldOnPerson: heldSince !== undefined && entry.sequence >= heldSince,
      }),
  );
  if (steering.length === 0) return { held };
  return {
    held: retain(held, (entry) => !steering.includes(entry as HeldDelivery)),
    selection: {
      delivery: combine(steering),
      handoffEligible: false,
      kind: "turn",
      sequences: steering.map(({ sequence }) => sequence),
    },
  };
}

/**
 * Between turns, the next thing held: a control runs alone, and a delivery starts a turn with
 * the deliveries right behind it from the same person. Sign-ins end with the turn that asked for
 * them, so a callback still held between turns is stale, and dropped.
 */
export function takeNext(
  held: Held,
  options: {
    /** The sequence of a delivery that arrived while nothing else was held or waiting. */
    readonly fresh?: number;
  } = {},
): { readonly held: Held; readonly taken?: Taken } {
  const entries = held.entries.filter(
    (entry): entry is HeldDelivery | HeldControl => entry.kind !== "sign-in",
  );
  const first = entries[0];
  if (first === undefined) return { held: { ...held, entries } };
  if (first.kind === "control")
    return {
      held: { ...held, entries: entries.slice(1) },
      taken:
        first.origin === undefined
          ? { control: first.control, kind: "control" }
          : { control: first.control, kind: "control", origin: first.origin },
    };
  const batch = [first, ...followingFrom(first, entries.slice(1))];
  const rest = entries.slice(batch.length);
  const sequences = batch.map(({ sequence }) => sequence);
  const delivery = combine(batch);
  return {
    held: { ...held, entries: rest },
    taken: {
      delivery,
      handoffEligible:
        sequences.length === 1 &&
        sequences[0] === options.fresh &&
        delivery.caller === undefined &&
        rest.length === 0,
      kind: "turn",
      sequences,
    },
  };
}

/**
 * Consecutive deliveries of one authenticated principal and one delegated call share a turn, as
 * they would steer it. Claims may change between them; the turn runs with the latest.
 */
function followingFrom(
  first: HeldDelivery,
  rest: readonly (HeldDelivery | HeldControl)[],
): HeldDelivery[] {
  const principal = principalOf(first.delivery.auth);
  if (principal === ANONYMOUS_PRINCIPAL) return [];
  const following: HeldDelivery[] = [];
  let callId = first.delivery.caller?.callId;
  for (const next of rest) {
    if (
      next.kind !== "delivery" ||
      principalOf(next.delivery.auth) !== principal ||
      (callId !== undefined &&
        next.delivery.caller !== undefined &&
        next.delivery.caller.callId !== callId)
    )
      break;
    following.push(next);
    callId ??= next.delivery.caller?.callId;
  }
  return following;
}

/**
 * Only the turn's own principal steers it; another principal's message waits for the turn to
 * end. A delivery without auth acts as the session's current identity, which is the turn's.
 * `heldOnPerson` lets a queued message steer a turn that waits on its person.
 */
export function isSteeringDelivery(
  delivery: DeliverHookPayload,
  turn: SteeringTurn,
  options?: { readonly heldOnPerson?: boolean },
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
      (payload) => payload.message !== undefined && payload.answers === undefined,
    )
  );
}

/** The first delivery held that isn't routed to its children yet. */
export function unrouted(held: Held): HeldDelivery | undefined {
  return held.entries.find(
    (entry): entry is HeldDelivery => entry.kind === "delivery" && entry.sequence >= held.routed,
  );
}

function append(held: Held, entry: HeldEntry): Held {
  return { ...held, entries: [...held.entries, entry], next: held.next + 1 };
}

function retain(held: Held, keeps: (entry: HeldEntry) => boolean): Held {
  return { ...held, entries: held.entries.filter(keeps) };
}

function combine(entries: readonly HeldDelivery[]): DeliverHookPayload {
  if (entries.length === 1) return entries[0]!.delivery;
  return coalesceDeliveries(entries.map(({ delivery }) => delivery));
}

function signInAttemptId(payload: DeliverPayload): string | undefined {
  const callback = payload["authorizationCallback"] as { readonly attemptId?: unknown } | undefined;
  return typeof callback?.attemptId === "string" ? callback.attemptId : undefined;
}
