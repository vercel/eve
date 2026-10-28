import type { DeliverHookPayload, TurnPolicy } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import { getAdapterKind } from "#channel/adapter.js";
import { serializeFilePartsInMessage } from "#channel/send-input.js";
import { ChannelDeliveryKey, ChannelInstrumentationKey } from "#context/keys.js";
import type { HookContext, HookSendOptions, HookSendResult } from "#public/definitions/hook.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { MessageContent } from "#shared/message-content.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
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
  let sends = 0;
  const send = (message: MessageContent, options: HookSendOptions): HookSendResult => {
    assertOpen("send");
    const empty = typeof message === "string" ? message.trim().length === 0 : message.length === 0;
    if (empty) throw new TypeError(`Hook "${label}" called ctx.send() without a message.`);
    if (options?.auth === undefined) {
      throw new TypeError(
        `Hook "${label}" called ctx.send() without auth. Pass ctx.session.auth.current to act as the session's current identity, or null for no caller.`,
      );
    }
    const { turnPolicy = "steer", ...rest } = options;
    const projection = currentProjection(ctx);
    const turnId = latestTurnIdOf(projection);
    // The commit that admits a turn's delivery, before the turn opens: the message is about it.
    const opening =
      call.input.cancelBeforeTurn !== undefined && activeTurnIdOf(projection) === undefined;
    // A cancel no hook asked for stops hooks too: none starts a turn until another turn starts.
    if (
      !opening &&
      activeTurnIdOf(projection) === undefined &&
      cancelledOutsideHooks(ctx, turnId)
    ) {
      return { reason: "cancelled", recorded: false };
    }
    const key = `${idempotencyKey}:send:${sends++}`;
    const deliveryId = `hook-${digestOf(key)}`;
    requested.push({
      delivery: hookDelivery(ctx, {
        ...rest,
        deliveryId,
        idempotencyKey: key,
        message,
        slug: call.slug,
        // A yielding message is queued; the session admits it only once nothing else waits.
        turnPolicy: turnPolicy === "yield" ? "queue" : turnPolicy,
      }),
      ...(turnPolicy === "yield" && {
        preemptible: opening ? { opening: true as const, turnId } : { turnId },
      }),
      type: "send",
    });
    return { deliveryId, recorded: true };
  };
  const hookContext: HookContext = {
    ...base,
    ...frame,
    agent: agentOf(ctx),
    cancel,
    memo: memos.memo,
    occurrence: { abortSignal, idempotencyKey },
    position: call.position,
    send,
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
    if (beforeTurn === undefined) queueCommands(ctx, call.reaction, idempotencyKey, requested);
    else {
      // A cancel stops the turn the delivery is about to start; a send still goes to the session.
      queueCommands(
        ctx,
        call.reaction,
        idempotencyKey,
        requested.filter((command) => command.type !== "cancel"),
      );
      for (const command of requested)
        if (command.type === "cancel")
          beforeTurn({
            hook: label,
            ...(command.reason !== undefined && { reason: command.reason }),
          });
    }
  } catch (error) {
    mergeMemos(ctx, memoScope, memos.used());
    reportReactionFailure(ctx, call.reaction, error, idempotencyKey);
  } finally {
    settled = true;
    memos.close();
  }
}

/**
 * The session's latest turn settled cancelled, and no hook's cancel stopped it: `session.cancel()`,
 * from a person, a client, or the server, or the session ending.
 */
function cancelledOutsideHooks(ctx: ContextContainer, turnId: string | undefined): boolean {
  if (turnId === undefined) return false;
  const turn = currentProjection(ctx).view.turns[turnId];
  return (
    turn?.status === "settled" &&
    turn.outcome === "cancelled" &&
    readReactionsState(ctx).cancelledTurnId !== turnId
  );
}

function agentOf(ctx: ContextContainer): HookContext["agent"] {
  const bundle = ctx.require(BundleKey);
  return { name: bundle.turnAgent.id, nodeId: bundle.nodeId };
}

/**
 * A hook's message as a delivery into its own session. It keeps the session's channel, so the
 * channel's `deliver` hook reads it like any other message. Its source names the hook, from which
 * the prompt tells the model no person wrote it; the message and context stay as the hook passed
 * them.
 */
function hookDelivery(
  ctx: ContextContainer,
  input: Pick<HookSendOptions, "auth" | "context"> & {
    readonly deliveryId: string;
    readonly idempotencyKey: string;
    readonly message: MessageContent;
    readonly slug: string;
    readonly turnPolicy: TurnPolicy;
  },
): DeliverHookPayload {
  const channel = ctx.get(ChannelDeliveryKey);
  const channelKind =
    channel?.channelKind ??
    ctx.get(ChannelInstrumentationKey)?.kind ??
    getAdapterKind(ctx.require(ChannelKey));
  return {
    auth: input.auth,
    deliveryMetadata: [
      {
        channelKind,
        channelName: channel?.channelName ?? channelKind,
        deliveryId: input.deliveryId,
        hook: input.slug,
        payloadIndex: 0,
      },
    ],
    idempotencyKey: input.idempotencyKey,
    kind: "deliver",
    payloads: [
      {
        ...(input.context !== undefined && { context: input.context }),
        message: serializeFilePartsInMessage(input.message),
      },
    ],
    turnPolicy: input.turnPolicy,
  };
}
