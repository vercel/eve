import type { SessionAuthContext } from "#channel/types.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type {
  ScheduleOccurrenceIdentity,
  ScheduleScopeContext,
} from "#public/schedules/collection.js";
import type { JsonValue } from "#shared/json.js";

type Awaitable<T> = T | Promise<T>;

/** Context passed to a delivery's `capture` while the creator's session is still live. */
export interface ScheduleCaptureContext extends ScheduleScopeContext {
  /** Validated request the schedule will run. */
  readonly request: unknown;
  /** Validated application metadata stored with the schedule. */
  readonly metadata: unknown;
}

/** Context shared by `verify` and `deliver` when an occurrence fires. */
export interface ScheduleDeliveryContext<TBinding> {
  /** Signal that aborts when this delivery attempt times out. */
  readonly abortSignal: AbortSignal;
  /** Execution auth re-resolved through the collection's `auth` before this attempt. */
  readonly auth: SessionAuthContext;
  /** Value returned by `capture` at creation; `undefined` when the delivery has no `capture`. */
  readonly binding: TBinding;
  /** Stable across retries of this delivery for one occurrence; pass it to idempotent APIs. */
  readonly idempotencyKey: string;
  readonly occurrence: ScheduleOccurrenceIdentity;
}

/** Result of `verify`. Returning a refusal fails the delivery permanently. */
export type ScheduleDeliveryVerification =
  | true
  | { readonly allowed: false; readonly reason: string };

/**
 * One named place a schedule's result can go, written as code on the
 * collection. The model chooses deliveries by name; everything else comes from
 * trusted context through `capture`.
 *
 * @typeParam TBinding - JSON value captured at creation and passed back at delivery time.
 */
export interface ScheduleDeliveryDefinition<TBinding extends JsonValue | undefined = undefined> {
  /**
   * Read by the model when it chooses deliveries and writes content: describe
   * the destination, the expected format, and any length limits.
   */
  readonly description: string;
  /**
   * Runs at creation inside the creator's session. Record the destination from
   * trusted context and throw to refuse the delivery. The message reaches the
   * model, so make it actionable. It must be idempotent and free of side
   * effects. Prefer storing references (a user id) over sensitive values (a
   * phone number): the binding is persisted with the schedule.
   */
  readonly capture?: (
    context: ScheduleCaptureContext,
  ) => Awaitable<{ readonly label?: string; readonly binding: TBinding }>;
  /**
   * Runs immediately before every `deliver` attempt. Return a refusal when the
   * recipient may no longer receive this content; it fails the delivery
   * permanently. Throw to retry. This is where the recipient guarantee lives:
   * check the binding against the current `auth`.
   */
  readonly verify?: (
    context: ScheduleDeliveryContext<TBinding>,
  ) => Awaitable<ScheduleDeliveryVerification>;
  /**
   * Sends the content the model wrote for this delivery, after the occurrence
   * settles. Attempts may repeat, so key external effects on `idempotencyKey`.
   * Throw {@link DeliveryRejected} for failures that retrying cannot fix.
   */
  readonly deliver: (
    context: ScheduleDeliveryContext<TBinding> & { readonly content: string },
  ) => Promise<void>;
}

/**
 * Defines a schedule delivery. This is an identity helper that types `binding`
 * across `capture`, `verify`, and `deliver`.
 *
 * @example A per-user delivery that re-checks its recipient before sending
 * ```ts
 * const sms = defineScheduleDelivery({
 *   description: "Text the creator's phone. Plain text, at most 320 characters.",
 *   capture: async ({ session }) => ({
 *     label: "SMS to the phone on file",
 *     binding: { userId: session.auth.principalId },
 *   }),
 *   verify: async ({ binding, auth }) =>
 *     (await phoneBelongsTo(binding.userId, auth)) || { allowed: false, reason: "Phone changed." },
 *   deliver: async ({ content, binding, idempotencyKey }) =>
 *     await sendSms(binding.userId, content, { idempotencyKey }),
 * });
 * ```
 */
export function defineScheduleDelivery<TBinding extends JsonValue | undefined = undefined>(
  definition: ExactDefinition<
    ScheduleDeliveryDefinition<TBinding>,
    ScheduleDeliveryDefinition<TBinding>
  >,
): ScheduleDeliveryDefinition<TBinding> {
  return definition;
}

const DELIVERY_REJECTED = Symbol.for("eve:schedule-delivery-rejected");

/**
 * Throw from `deliver` when retrying cannot help, such as content that breaks
 * the destination's limits. The delivery fails permanently with this message.
 */
export class DeliveryRejected extends Error {
  readonly [DELIVERY_REJECTED] = true;

  constructor(message: string) {
    super(message);
    this.name = "DeliveryRejected";
  }
}

/** Matches by brand so duplicated copies of eve still agree. */
export function isDeliveryRejected(error: unknown): error is DeliveryRejected {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[DELIVERY_REJECTED] === true
  );
}
