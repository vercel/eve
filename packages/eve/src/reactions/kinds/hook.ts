import { getAdapterKind } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { runOnSelection, type ContextContainer } from "#context/container.js";
import { ContinuationTokenKey } from "#context/keys.js";
import type { ReactionView } from "#dynamic/definition.js";
import type { HookContext, HookOccurrence, HookRunContext } from "#public/definitions/hook.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { queueIntents, reportReactionFailure, type Occurrence } from "../intents.js";
import { requireHistory, type InternalRecordContext, type Reaction } from "../reaction.js";

/**
 * An authored hook as a reaction: `select` with `run`, or `events` handlers. Both run after every
 * commit. What they return are intents, which act once per occurrence: each new selection, or each
 * fact an events handler receives. `ctx.occurrence.id` keys a side effect that must happen once.
 */
export function hookReaction(hook: ResolvedHookDefinition): Reaction {
  const id = `hook:${hook.slug}`;
  const base = { id, kind: "hook" as const, label: hook.logicalPath, timing: "commit" as const };
  if (hook.select !== undefined && hook.run !== undefined) {
    const run = hook.run as (selected: unknown, ctx: HookRunContext) => unknown;
    return {
      ...base,
      contribute: (result, ctx) => ({
        value: queueIntents(ctx.ctx, id, hook.logicalPath, [
          { occurrence: occurrenceOf(ctx, hook).id, result },
        ]),
      }),
      record: (selected, ctx) => {
        // Built in the session's context, which run itself runs outside of.
        const runContext = hookRunContext(ctx, hook, occurrenceOf(ctx, hook));
        return runOnSelection(hook.logicalPath, () => run(selected, runContext));
      },
      select: hook.select as (view: ReactionView, ctx: unknown) => unknown,
    };
  }
  const keys = Object.keys(hook.events).sort();
  return {
    ...base,
    contribute: (results, ctx) => ({
      value: queueIntents(ctx.ctx, id, hook.logicalPath, results as readonly Occurrence[]),
    }),
    record: (_selected, ctx) => dispatchEvents(hook, ctx, base),
    select: (view) => keys.map((key) => view.latest[key] ?? null),
  };
}

/**
 * A select-form hook's occurrence: the hook, how many selections it has had, and the selection's
 * digest. A retry computes the same one, since nothing new was committed; a selection that comes
 * back later, as `false → true → false → true` does, is a new one.
 */
function occurrenceOf(ctx: InternalRecordContext, hook: ResolvedHookDefinition): HookOccurrence {
  return { id: `${ctx.session.id}:${hook.slug}:${ctx.occurrence}:${ctx.digest}` };
}

/**
 * Runs the hook's handlers for each record the commit carries, typed handler first, then `*`. A
 * handler that throws fails the running turn; the others still run.
 */
async function dispatchEvents(
  hook: ResolvedHookDefinition,
  ctx: InternalRecordContext,
  reaction: Pick<Reaction, "id" | "kind" | "label">,
): Promise<readonly Occurrence[]> {
  const results: Occurrence[] = [];
  if (ctx.written.length === 0) return results;
  const base = hookContextBase(ctx.ctx);
  for (const { event: written, position, progress, view } of ctx.written) {
    const { meta: _meta, ...event } = written;
    const occurrence = { id: `${base.session.id}:${hook.slug}:${position.line}.${position.index}` };
    const handlers = [hook.events[event.type], progress ? undefined : hook.events["*"]];
    for (const handler of handlers) {
      if (handler === undefined) continue;
      const hookContext: HookContext = { ...base, occurrence, position, view };
      try {
        results.push({
          occurrence: occurrence.id,
          result: await handler(event as never, hookContext),
        });
      } catch (error) {
        reportReactionFailure(ctx.ctx, reaction, error);
      }
    }
  }
  return results;
}

function hookContextBase(
  ctx: ContextContainer,
): Omit<HookContext, "occurrence" | "position" | "view"> {
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

function hookRunContext(
  ctx: InternalRecordContext,
  hook: ResolvedHookDefinition,
  occurrence: HookOccurrence,
): HookRunContext {
  const base = hookContextBase(ctx.ctx);
  return {
    abortSignal: ctx.abortSignal,
    agent: base.agent,
    channel: { ...ctx.channel, ...base.channel },
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
    getSandbox: base.getSandbox,
    messages: async () => requireHistory(ctx, hook.logicalPath),
    occurrence,
    session: { ...base.session, auth: ctx.session.auth },
  };
}
