import { getAdapterKind } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
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
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { InternalResolveContext, Reaction } from "../reaction.js";
import { readReactionsState, type Slot } from "../state.js";

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
      resolve: (selected, ctx) => resolve(selected, hookResolveContext(ctx)),
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
    facts: ctx.facts,
    getSandbox: base.getSandbox,
    session: { ...base.session, auth: ctx.session.auth },
  };
}

/** A hook's result as the intents in its slot. A cancel names the turn it stops. */
function intentsOf(result: unknown, label: string): JsonValue {
  const intents: JsonObject[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const intent = value as Partial<HookIntent>;
    if (typeof value !== "object" || intent.kind !== INTENT_KIND) {
      throw new Error(
        `Hook "${label}" returned something other than an intent. Return cancel(), compact(), or nothing.`,
      );
    }
    if (intent.type === "cancel") {
      const turnId = currentProjection().activeTurnId;
      if (turnId === undefined) return;
      intents.push({
        turnId,
        type: "cancel",
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      });
    } else if (intent.type === "compact") {
      intents.push({ key: intent.key ?? "hook", type: "compact" });
    }
  };
  visit(result);
  return intents.length === 0 ? null : intents;
}

export function hasIntent(slot: Slot | undefined, type: HookIntent["type"]): boolean {
  return (
    Array.isArray(slot?.value) &&
    slot.value.some((intent) => (intent as { readonly type?: unknown }).type === type)
  );
}

/**
 * True while a hook's compact intent waits: no compaction has started since the slot asked for
 * one. The compaction that follows satisfies it, so a slot that keeps asking compacts once.
 */
export function hasPendingCompaction(ctx: Pick<ContextContainer, "get"> | undefined): boolean {
  const state = readReactionsState(ctx);
  const compacted = state.latest["context.started:compaction"] ?? -1;
  return Object.entries(state.slots).some(
    ([id, slot]) => id.startsWith("hook:") && hasIntent(slot, "compact") && compacted <= slot.since,
  );
}
