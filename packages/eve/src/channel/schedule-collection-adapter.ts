import type { ChannelAdapterContext, ChannelEventHandlers } from "#channel/adapter.js";
import type { SessionAuthContext } from "#channel/types.js";
import { resolveKey, type ContextKey } from "#context/key.js";
import { BUNDLE_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { createLogger } from "#internal/logging.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleDeliveryBinding,
  ScheduleDeliveryEvent,
  ScheduleOccurrenceIdentity,
  SchedulePrincipalReference,
} from "#public/schedules/collection.js";
import { isDeliveryRejected } from "#public/schedules/delivery.js";
import type { ScheduleDeliveryContext } from "#public/schedules/delivery.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const log = createLogger("channel.schedule-collection-adapter");

const STATE_KEY = "scheduleCollection";
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
const MAX_REASON_LENGTH = 500;
const MAX_REPLY_LENGTH = 60_000;

type DeliveryStatus = "pending" | "succeeded" | "failed";

/**
 * Durable state of one collection occurrence's session, kept on its schedule
 * adapter. It carries everything the settle step needs, because the closure
 * that started the occurrence is gone by then.
 */
export interface ScheduleCollectionAdapterState {
  readonly collection: string;
  /** Model-written content by delivery name, captured when the structured result completes. */
  content?: Record<string, string>;
  /** The model's latest reply text; the content of a single-delivery occurrence. */
  lastMessage?: string;
  readonly deliveries: Readonly<Record<string, ScheduleDeliveryBinding>>;
  readonly metadata: JsonValue;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly principal: SchedulePrincipalReference;
  status: Record<string, DeliveryStatus>;
}

/** Adds the marker every scheduled run carries; schedule management is refused while it is set. */
export function markScheduledRunAuth(auth: SessionAuthContext): SessionAuthContext {
  return { ...auth, attributes: { ...auth.attributes, "eve.scheduled_run": "true" } };
}

/** Initial adapter state for a collection occurrence's session. */
export function createScheduleCollectionAdapterState(input: {
  readonly collection: string;
  readonly deliveries: Readonly<Record<string, ScheduleDeliveryBinding>>;
  readonly metadata: unknown;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly principal: SchedulePrincipalReference;
}): Record<string, unknown> {
  const state: ScheduleCollectionAdapterState = {
    collection: input.collection,
    deliveries: input.deliveries,
    metadata: input.metadata as JsonValue,
    occurrence: input.occurrence,
    principal: input.principal,
    status: Object.fromEntries(Object.keys(input.deliveries).map((name) => [name, "pending"])),
  };
  return { [STATE_KEY]: state };
}

/**
 * Structured output for the occurrence's run: one string per selected
 * delivery, each described by that delivery, so the model writes content
 * suited to every destination in a single pass.
 */
export function scheduleDeliveryOutputSchema(
  definition: ScheduleCollectionDefinition<unknown, unknown>,
  names: readonly string[],
): JsonObject {
  return {
    type: "object",
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        { type: "string", description: definition.deliveries[name]!.description },
      ]),
    ),
    required: [...names],
    additionalProperties: false,
  };
}

// Resolved by name: `BundleKey` lives with the runtime adapter registry, which imports this module.
async function reloadDefinition(
  context: ChannelAdapterContext,
  collection: string,
): Promise<ScheduleCollectionDefinition<unknown, unknown>> {
  const bundleKey = resolveKey(BUNDLE_CONTEXT_KEY_NAME) as
    | ContextKey<CompiledRuntimeAgentBundle>
    | undefined;
  if (bundleKey === undefined) throw new Error("The runtime bundle key is not registered.");
  return await loadScheduleCollectionDefinition(context.ctx.require(bundleKey), collection);
}

function readState(context: ChannelAdapterContext): ScheduleCollectionAdapterState | undefined {
  const value = (context.state as Record<string, unknown>)[STATE_KEY];
  return typeof value === "object" && value !== null
    ? (value as ScheduleCollectionAdapterState)
    : undefined;
}

function pendingNames(state: ScheduleCollectionAdapterState): string[] {
  return Object.keys(state.deliveries).filter((name) => state.status[name] === "pending");
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_REASON_LENGTH);
}

async function captureContent(
  data: { readonly result: JsonValue },
  context: ChannelAdapterContext,
): Promise<void> {
  const state = readState(context);
  if (state === undefined || typeof data.result !== "object" || data.result === null) return;
  const result = data.result as Record<string, JsonValue>;
  const content: Record<string, string> = {};
  for (const name of Object.keys(state.deliveries)) {
    const value = result[name];
    if (typeof value === "string" && value.trim() !== "") content[name] = value;
  }
  state.content = content;
}

function captureMessage(data: { readonly message: string }, context: ChannelAdapterContext): void {
  const state = readState(context);
  if (state !== undefined) state.lastMessage = data.message.slice(0, MAX_REPLY_LENGTH);
}

async function settleDeliveries(context: ChannelAdapterContext): Promise<void> {
  const state = readState(context);
  if (state === undefined) return;
  const names = pendingNames(state);
  if (names.length === 0) return;
  const selected = Object.keys(state.deliveries);
  // One delivery requests no structured output: its content is the final reply.
  if (state.content === undefined && selected.length === 1 && state.lastMessage?.trim())
    state.content = { [selected[0]!]: state.lastMessage.trim() };
  let definition: ScheduleCollectionDefinition<unknown, unknown>;
  try {
    definition = await reloadDefinition(context, state.collection);
  } catch (error) {
    // Nothing can be delivered or reported without the definition; leave the deliveries pending
    // so a replay of this step can try again.
    log.error("schedule collection definition could not be reloaded for delivery", {
      collection: state.collection,
      error,
    });
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const content = state.content?.[name];
      const outcome =
        content === undefined
          ? ({ ok: false, reason: "The run produced no content for this delivery." } as const)
          : await runDelivery(definition, state, name, content, context.session.id);
      await report(definition, state, name, context.session.id, outcome);
    }),
  );
}

async function failPendingDeliveries(
  context: ChannelAdapterContext,
  reason: string,
): Promise<void> {
  const state = readState(context);
  if (state === undefined) return;
  const names = pendingNames(state);
  if (names.length === 0) return;
  let definition: ScheduleCollectionDefinition<unknown, unknown> | undefined;
  try {
    definition = await reloadDefinition(context, state.collection);
  } catch (error) {
    log.error("schedule collection definition could not be reloaded to report failures", {
      collection: state.collection,
      error,
    });
  }
  await Promise.all(
    names.map(async (name) => {
      if (definition === undefined) {
        state.status[name] = "failed";
        return;
      }
      await report(definition, state, name, context.session.id, { ok: false, reason });
    }),
  );
}

type DeliveryOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

async function runDelivery(
  definition: ScheduleCollectionDefinition<unknown, unknown>,
  state: ScheduleCollectionAdapterState,
  name: string,
  content: string,
  sessionId: string,
): Promise<DeliveryOutcome> {
  const delivery = Object.hasOwn(definition.deliveries, name)
    ? definition.deliveries[name]
    : undefined;
  if (delivery === undefined)
    return { ok: false, reason: `Delivery "${name}" is no longer configured.` };
  const binding = state.deliveries[name]?.binding;
  const idempotencyKey = `${state.occurrence.executionId}:${name}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Delivery attempt timed out.")),
      ATTEMPT_TIMEOUT_MS,
    );
    try {
      return await withDeadline(controller.signal, async () => {
        const resolved = await definition.auth({
          principal: state.principal,
          metadata: state.metadata,
          occurrence: state.occurrence,
        });
        if (resolved === null)
          return { ok: false, reason: "Scheduled execution is no longer authorized." } as const;
        const context: ScheduleDeliveryContext<any> = {
          abortSignal: controller.signal,
          auth: markScheduledRunAuth(resolved),
          binding,
          idempotencyKey,
          occurrence: state.occurrence,
        };
        const verification = delivery.verify === undefined ? true : await delivery.verify(context);
        if (verification !== true)
          return {
            ok: false,
            reason:
              typeof verification?.reason === "string" && verification.reason !== ""
                ? verification.reason.slice(0, MAX_REASON_LENGTH)
                : "The delivery refused to send.",
          } as const;
        await delivery.deliver({ ...context, content });
        return { ok: true } as const;
      });
    } catch (error) {
      if (isDeliveryRejected(error)) return { ok: false, reason: reasonOf(error) };
      lastError = error;
      log.warn("schedule delivery attempt failed", {
        attempt,
        collection: state.collection,
        delivery: name,
        sessionId,
        error,
      });
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
  }
  return { ok: false, reason: reasonOf(lastError) };
}

async function report(
  definition: ScheduleCollectionDefinition<unknown, unknown>,
  state: ScheduleCollectionAdapterState,
  name: string,
  sessionId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  state.status[name] = outcome.ok ? "succeeded" : "failed";
  const { occurrence } = state;
  if (outcome.ok)
    log.info("schedule delivery succeeded", { collection: state.collection, delivery: name });
  else
    log.warn("schedule delivery failed", {
      collection: state.collection,
      delivery: name,
      reason: outcome.reason,
    });
  const event: ScheduleDeliveryEvent = {
    collection: state.collection,
    delivery: name,
    executionId: occurrence.executionId,
    name: occurrence.name,
    occurrence,
    scheduleId: occurrence.scheduleId,
    scheduledAt: occurrence.scheduledAt,
    sessionId,
    reason: outcome.ok ? undefined : outcome.reason,
    type: outcome.ok ? "delivery.succeeded" : "delivery.failed",
  };
  try {
    await definition.events?.[event.type]?.(event);
  } catch (error) {
    log.error("schedule delivery event handler threw", { collection: state.collection, error });
  }
}

async function withDeadline<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream handlers for a collection occurrence's session. Adapter handler errors
 * are swallowed by the runtime, so nothing here throws: every outcome is
 * recorded in adapter state and reported through the collection's events.
 * Sessions without collection state (static schedules) pass through untouched.
 */
export const scheduleCollectionEventHandlers: ChannelEventHandlers = {
  "message.completed": (data, context) => captureMessage(data, context),
  "result.completed": (data, context) => captureContent(data, context),
  "turn.completed": (_data, context) => settleDeliveries(context),
  "turn.failed": (data, context) =>
    failPendingDeliveries(context, `The occurrence's turn failed: ${data.message}`),
  "turn.cancelled": (_data, context) =>
    failPendingDeliveries(context, "The occurrence's turn was cancelled."),
  "session.failed": (data, context) =>
    failPendingDeliveries(context, `The occurrence's session failed: ${data.message}`),
};
