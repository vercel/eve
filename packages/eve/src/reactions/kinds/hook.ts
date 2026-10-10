import { getAdapterKind } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { runOnSelection, type ContextContainer } from "#context/container.js";
import { ContinuationTokenKey } from "#context/keys.js";
import type { ReactionView } from "#dynamic/definition.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  INTENT_KIND,
  type HookContext,
  type HookIntent,
  type HookResolveContext,
} from "#public/definitions/hook.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { JsonValue } from "#shared/json.js";
import type { InternalResolveContext, Reaction } from "../reaction.js";
import { readReactionsState, type ReactionsState, type Slot } from "../state.js";

const log = createLogger("hooks");

/** An authored hook as a reaction. An `events` map selects the latest position of each key. */
export function hookReaction(hook: ResolvedHookDefinition): Reaction {
  const base = {
    contribute: (result: unknown) => ({ value: intentsOf(result, hook.logicalPath) }),
    id: `hook:${hook.slug}`,
    kind: "hook" as const,
    label: hook.logicalPath,
  };
  if (hook.resolve !== undefined) {
    const resolve = hook.resolve as (selected: unknown, ctx: HookResolveContext) => unknown;
    return {
      ...base,
      resolve: (selected, ctx) => {
        const hookContext = hookResolveContext(ctx);
        return runOnSelection(hook.logicalPath, () => resolve(selected, hookContext));
      },
      ...(hook.select === undefined
        ? {}
        : { select: hook.select as (view: ReactionView, ctx: unknown) => unknown }),
    };
  }
  const keys = Object.keys(hook.events).sort();
  return {
    ...base,
    resolve: (_selected, ctx) => dispatchEvents(hook, ctx),
    select: (view) => keys.map((key) => view.latest[key] ?? null),
  };
}

/** Runs the hook's handlers for each record the commit carries, typed handler first, then `*`. */
async function dispatchEvents(
  hook: ResolvedHookDefinition,
  ctx: InternalResolveContext,
): Promise<readonly unknown[]> {
  const results: unknown[] = [];
  if (ctx.written.length === 0) return results;
  const base = hookContextBase(ctx.ctx);
  for (const { event: written, position, progress, view } of ctx.written) {
    const { meta: _meta, ...event } = written;
    const handlers = [hook.events[event.type], progress ? undefined : hook.events["*"]];
    for (const handler of handlers) {
      if (handler === undefined) continue;
      const hookContext: HookContext = { ...base, position, view };
      try {
        results.push(await handler(event as never, hookContext));
      } catch (error) {
        logError(log, "stream event hook failed", error, {
          eventType: event.type,
          hook: hook.slug,
          position,
          sessionId: base.session.id,
        });
      }
    }
  }
  return results;
}

function hookContextBase(ctx: ContextContainer): Omit<HookContext, "position" | "view"> {
  const bundle = ctx.require(BundleKey);
  const channelAdapter = ctx.get(ChannelKey);
  return {
    ...buildCallbackContext(),
    agent: { name: bundle.turnAgent.id, nodeId: bundle.nodeId },
    channel: {
      continuationToken: ctx.get(ContinuationTokenKey),
      kind: channelAdapter === undefined ? undefined : getAdapterKind(channelAdapter),
    },
  };
}

function hookResolveContext(ctx: InternalResolveContext): HookResolveContext {
  const base = hookContextBase(ctx.ctx);
  return {
    abortSignal: ctx.abortSignal,
    agent: base.agent,
    channel: { ...ctx.channel, ...base.channel },
    ...(ctx.conversation === undefined ? {} : { conversation: ctx.conversation }),
    getSandbox: base.getSandbox,
    session: { ...base.session, auth: ctx.session.auth },
  };
}

/** One intent as a slot records it: its key, which it acts once for, and what it asks. */
interface RecordedIntent {
  readonly key: string;
  readonly type: HookIntent["type"];
  readonly reason?: string;
  readonly turnId?: string;
}

/**
 * A hook's result as the intents in its slot. A cancel is keyed by the turn it stops, the one
 * running when the hook resolved; a compact by its name in a result map, or `default`.
 */
function intentsOf(result: unknown, label: string): JsonValue {
  const intents = new Map<string, RecordedIntent>();
  const record = (value: unknown, name: string): void => {
    const intent = value as Partial<HookIntent>;
    if (intent.type === "cancel") {
      const turnId = currentProjection().activeTurnId;
      if (turnId === undefined) return;
      intents.set(`cancel:${turnId}`, {
        key: `cancel:${turnId}`,
        turnId,
        type: "cancel",
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      });
    } else if (intent.type === "compact") {
      intents.set(`compact:${name}`, {
        key: `compact:${name}`,
        type: "compact",
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      });
    }
  };
  const visit = (value: unknown, name: string): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, name);
      return;
    }
    if (typeof value !== "object") throw notAnIntent(label);
    if ((value as Partial<HookIntent>).kind === INTENT_KIND) {
      record(value, name);
      return;
    }
    if (name !== "default") throw notAnIntent(label);
    for (const [entry, intent] of Object.entries(value)) {
      if (intent === null || intent === undefined) continue;
      if ((intent as Partial<HookIntent>).kind !== INTENT_KIND) throw notAnIntent(label);
      record(intent, entry);
    }
  };
  visit(result, "default");
  return intents.size === 0 ? null : ([...intents.values()] as unknown as JsonValue);
}

function notAnIntent(label: string): Error {
  return new Error(
    `Hook "${label}" returned something other than intents. Return cancel(), compact(), a map of them, or nothing.`,
  );
}

function recordedIntents(slot: Slot | undefined): readonly RecordedIntent[] {
  return Array.isArray(slot?.value) ? (slot.value as unknown as readonly RecordedIntent[]) : [];
}

/** The hook intents of `type` the session hasn't acted on, with the reaction that asked. */
export function pendingIntents(
  ctx: Pick<ContextContainer, "get"> | undefined,
  type: HookIntent["type"],
): readonly { readonly reactionId: string; readonly intent: RecordedIntent }[] {
  const state = readReactionsState(ctx);
  return Object.entries(state.slots).flatMap(([reactionId, slot]) => {
    if (!reactionId.startsWith("hook:")) return [];
    const satisfied = new Set(state.satisfied?.[reactionId] ?? []);
    return recordedIntents(slot)
      .filter((intent) => intent.type === type && !satisfied.has(intent.key))
      .map((intent) => ({ intent, reactionId }));
  });
}

/**
 * Records that the session acted on these intents. A reaction keeps one cancel key, its latest
 * turn's, since a cancel never applies to a turn after its own.
 */
export function satisfyIntents(
  state: ReactionsState,
  acted: readonly { readonly reactionId: string; readonly intent: RecordedIntent }[],
): ReactionsState {
  if (acted.length === 0) return state;
  const satisfied = { ...state.satisfied };
  for (const { intent, reactionId } of acted) {
    const keys = (satisfied[reactionId] ?? []).filter(
      (key) => !(intent.type === "cancel" && key.startsWith("cancel:")),
    );
    satisfied[reactionId] = keys.includes(intent.key) ? keys : [...keys, intent.key];
  }
  return { ...state, satisfied };
}

/** True while a hook's compact intent waits for a compaction to start. */
export function hasPendingCompaction(ctx: Pick<ContextContainer, "get"> | undefined): boolean {
  return pendingIntents(ctx, "compact").length > 0;
}
