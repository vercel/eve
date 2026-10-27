import {
  MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
  validateDeliveryIdempotencyKey,
} from "#channel/delivery-idempotency.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import { getAdapterKind } from "#channel/adapter.js";
import { serializeFilePartsInMessage } from "#channel/send-input.js";
import { ChannelDeliveryKey, ChannelInstrumentationKey } from "#context/keys.js";
import {
  HOOK_FOLLOW_UP_KEYS,
  type HookContext,
  type HookFollowUpOptions,
  type HookFollowUpResult,
  type HookEventKey,
} from "#public/definitions/hook.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { MessageContent } from "#shared/message-content.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { TurnSettledData } from "#protocol/session-events/families/turn.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { followsUp } from "../follow-up.js";
import { queueCommands, reportReactionFailure, type Command } from "../intents.js";
import { sessionFrameOf } from "../frame.js";
import type { CommitContext, CommitReaction } from "../reaction.js";
import { openMemos } from "../records.js";
import {
  digestOf,
  discardedByDeployment,
  keepMemos,
  mergeMemos,
  readReactionsState,
} from "../state.js";

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
            slug: hook.slug,
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
  readonly slug: string;
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
  const assertOpen = (method: string): void => {
    if (!settled) return;
    throw new Error(
      `Hook "${label}" called ctx.${method}() after its handler settled. Await the work that calls it before the handler returns.`,
    );
  };
  const cancel = (reason?: string): void => {
    assertOpen("cancel");
    requested.push(reason === undefined ? { type: "cancel" } : { reason, type: "cancel" });
  };
  const followUp = (
    message: MessageContent,
    options: HookFollowUpOptions = {},
  ): HookFollowUpResult => {
    assertOpen("followUp");
    const empty = typeof message === "string" ? message.trim().length === 0 : message.length === 0;
    if (empty) throw new TypeError(`Hook "${label}" called ctx.followUp() without a message.`);
    validateDeliveryIdempotencyKey(options.idempotencyKey);
    // `*` handlers receive it too, for every event; only a completed turn has a next turn.
    if (call.event.type !== "turn.settled") return { queued: false, reason: "not-settled" };
    const settledTurn = call.event.data as TurnSettledData;
    if (settledTurn.outcome !== "completed") return { queued: false, reason: "not-completed" };
    const { turnId } = settledTurn;
    if (followsUp(requested, turnId) || followsUp(readReactionsState(ctx).intents, turnId)) {
      return { queued: false, reason: "already-queued" };
    }
    // A long hook path can push the occurrence key past the delivery key limit.
    const key =
      options.idempotencyKey ??
      (idempotencyKey.length <= MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH
        ? idempotencyKey
        : `${sessionId}:hook-follow-up:${digestOf(idempotencyKey)}`);
    requested.push({
      delivery: hookDelivery(ctx, { ...options, idempotencyKey: key, message, slug: call.slug }),
      turnId,
      type: "follow-up",
    });
    return { queued: true };
  };
  const hookContext: HookContext = {
    ...base,
    ...frame,
    agent: agentOf(ctx),
    cancel,
    memo: memos.memo,
    occurrence: { abortSignal, idempotencyKey },
    position: call.position,
    session: { ...base.session, ...frame.session },
    // Only handlers whose key can follow up get the method, as their types say.
    ...(HOOK_FOLLOW_UP_KEYS[call.key as HookEventKey] === true && { followUp }),
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
    if (beforeTurn === undefined) queueCommands(ctx, call.reaction, idempotencyKey, requested);
    else
      for (const command of requested)
        if (command.type === "cancel")
          beforeTurn({
            hook: label,
            ...(command.reason !== undefined && { reason: command.reason }),
          });
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

/**
 * A hook's message as a delivery into its own session. It queues behind the running turn and
 * keeps the channel of the turn that settled, so the channel's `deliver` hook reads it like any
 * other message. A note ahead of it tells the model no person wrote it.
 */
function hookDelivery(
  ctx: ContextContainer,
  input: HookFollowUpOptions & {
    readonly idempotencyKey: string;
    readonly message: MessageContent;
    readonly slug: string;
  },
): DeliverHookPayload {
  const channel = ctx.get(ChannelDeliveryKey);
  const channelKind =
    channel?.channelKind ??
    ctx.get(ChannelInstrumentationKey)?.kind ??
    getAdapterKind(ctx.require(ChannelKey));
  const note = `The "${input.slug}" hook sent this follow-up after the last turn. No person wrote it.`;
  return {
    ...(input.auth !== undefined && { auth: input.auth }),
    deliveryMetadata: [
      {
        channelKind,
        channelName: channel?.channelName ?? channelKind,
        deliveryId: crypto.randomUUID(),
        hook: input.slug,
        payloadIndex: 0,
      },
    ],
    idempotencyKey: input.idempotencyKey,
    kind: "deliver",
    payloads: [
      {
        context: [note, ...(input.context ?? [])],
        message: serializeFilePartsInMessage(input.message),
      },
    ],
    turnPolicy: "queue",
  };
}
