import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import type { HookContext } from "#public/definitions/hook.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { queueCommands, reportReactionFailure, type Command } from "../intents.js";
import { sessionFrameOf } from "../frame.js";
import type { CommitContext, CommitReaction } from "../reaction.js";
import { openMemos } from "../records.js";
import { discardedByDeployment, keepMemos, mergeMemos, readReactionsState } from "../state.js";

/**
 * An authored hook as a reaction: its handlers run after every commit, once for each fact of
 * their type, typed handler first, then `*`. Its occurrence identifies the fact for external
 * services that support idempotency.
 */
export function hookReaction(hook: ResolvedHookDefinition): CommitReaction {
  const id = `hook:${hook.slug}`;
  const reaction = { id, kind: "hook" as const, label: hook.logicalPath };
  return {
    ...reaction,
    onCommit: async (input) => {
      for (const { event: written, position, progress, view } of input.written) {
        const { meta, ...event } = written;
        // Streamed progress reaches a handler that names it, and never `*`.
        for (const key of progress ? [event.type] : [event.type, "*"]) {
          const handler = hook.events[key];
          if (handler === undefined) continue;
          await runHandler({
            at: meta?.at,
            event,
            handler: handler as (event: unknown, ctx: HookContext) => unknown,
            input,
            key,
            occurrence: `${position.line}.${position.index}`,
            position,
            reaction,
            view,
          });
        }
      }
    },
    timing: "commit",
  };
}

async function runHandler(call: {
  readonly at: string | undefined;
  readonly event: Omit<SessionStreamEvent, "meta">;
  readonly handler: (event: unknown, ctx: HookContext) => unknown;
  readonly input: CommitContext;
  readonly key: string;
  readonly occurrence: string;
  readonly position: HookContext["position"];
  readonly reaction: Pick<CommitReaction, "id" | "kind" | "label">;
  readonly view: SessionTables;
}): Promise<void> {
  const { ctx, abortSignal } = call.input;
  const { id, label } = call.reaction;
  const base = buildCallbackContext();
  const frame = sessionFrameOf(ctx, { at: call.at, view: call.view });
  const sessionId = base.session.id;
  const idempotencyKey = `${sessionId}:${id}:${call.occurrence}:${call.key}`;
  const memoScope = `${id}#${call.key}`;
  let settled = false;
  const memos = openMemos({
    abortSignal,
    afterDeployment: discardedByDeployment(ctx, memoScope),
    kept: readReactionsState(ctx).memos?.[memoScope],
    label,
    scope: memoScope,
    sessionId,
  });
  const requested: Command[] = [];
  const command =
    (type: Command["type"]) =>
    (reason?: string): void => {
      if (settled) {
        throw new Error(
          `Hook "${label}" called ctx.${type}() after its handler settled. Await the work that calls it before the handler returns.`,
        );
      }
      requested.push(reason === undefined ? { type } : { reason, type });
    };
  const hookContext: HookContext = {
    ...base,
    ...frame,
    agent: agentOf(ctx),
    cancel: command("cancel"),
    memo: memos.memo,
    occurrence: { abortSignal, idempotencyKey },
    position: call.position,
    session: { ...base.session, ...frame.session },
  };
  try {
    await call.handler(call.event, hookContext);
    keepMemos(ctx, memoScope, memos.used());
    settled = true;
    // A handler that throws asks for nothing: its failure fails the turn instead.
    const beforeTurn =
      call.event.type === "delivery.admitted" &&
      activeTurnIdOf(currentProjection(ctx)) === undefined
        ? call.input.cancelBeforeTurn
        : undefined;
    if (beforeTurn === undefined) queueCommands(ctx, id, idempotencyKey, requested);
    else
      for (const { reason } of requested)
        beforeTurn({ hook: label, ...(reason !== undefined && { reason }) });
  } catch (error) {
    mergeMemos(ctx, memoScope, memos.used());
    reportReactionFailure(ctx, call.reaction, error, idempotencyKey);
  } finally {
    settled = true;
    memos.close();
  }
}

function agentOf(ctx: ContextContainer): HookContext["agent"] {
  const bundle = ctx.require(BundleKey);
  return { name: bundle.turnAgent.id, nodeId: bundle.nodeId };
}
