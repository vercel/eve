import type { DeliverHookPayload, TurnPolicy } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import { getAdapterKind } from "#channel/adapter.js";
import { serializeFilePartsInMessage } from "#channel/send-input.js";
import { ChannelDeliveryKey, ChannelInstrumentationKey } from "#context/keys.js";
import type { HookContext, HookSendOptions, HookSendResult } from "#public/definitions/hook.js";
import { principalOf } from "#execution/session/principal.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { MessageContent } from "#shared/message-content.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import { followUpKey } from "../hook-send.js";
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
  let sent = false;
  const send = (message: MessageContent, options: HookSendOptions = {}): HookSendResult => {
    assertOpen("send");
    const empty = typeof message === "string" ? message.trim().length === 0 : message.length === 0;
    if (empty) throw new TypeError(`Hook "${label}" called ctx.send() without a message.`);
    // One message per handler and event, so a hook that sends on every event can't flood a turn.
    if (sent) return { queued: false, reason: "already-queued" };
    const { turnPolicy = "yield", ...rest } = options;
    const deliveryId = `hook-${digestOf(idempotencyKey)}`;
    if (turnPolicy !== "yield") {
      sent = true;
      requested.push({
        delivery: hookDelivery(ctx, {
          ...rest,
          deliveryId,
          idempotencyKey: `${idempotencyKey}:send`,
          message,
          slug: call.slug,
          turnPolicy,
        }),
        type: "send",
      });
      return { deliveryId, queued: true };
    }
    // A follow-up waits on the running turn, or the latest one when none runs.
    const projection = currentProjection(ctx);
    const turnId = activeTurnIdOf(projection) ?? latestTurnIdOf(projection);
    const state = readReactionsState(ctx);
    const settledTurn = turnId === undefined ? undefined : projection.view.turns[turnId];
    if (settledTurn?.status === "settled") {
      // A hook that cancelled the turn can redirect it; a person's cancel stops the session.
      const cancelledHere =
        settledTurn.outcome === "cancelled" &&
        state.cancelledTurnId === turnId &&
        state.cancelledBy === id;
      if (settledTurn.outcome !== "completed" && !cancelledHere) {
        return { queued: false, reason: "not-completed" };
      }
    }
    const queued = [
      ...requested.flatMap((command) =>
        command.type === "follow-up" && command.turnId === turnId ? [command.delivery] : [],
      ),
      ...(state.followUp !== undefined && state.followUp.turnId === turnId
        ? [state.followUp.delivery]
        : []),
    ];
    if (
      queued.some(({ deliveryMetadata }) =>
        deliveryMetadata?.some((entry) => entry.hook === call.slug),
      )
    ) {
      return { queued: false, reason: "already-queued" };
    }
    // One delivery acts for one principal, so follow-ups join only when they agree on it.
    if (queued.length > 0 && authKey(queued[0]!.auth) !== authKey(rest.auth)) {
      return { queued: false, reason: "auth-conflict" };
    }
    sent = true;
    requested.push({
      delivery: hookDelivery(ctx, {
        ...rest,
        deliveryId,
        idempotencyKey: followUpKey(sessionId, turnId),
        message,
        slug: call.slug,
        turnPolicy: "queue",
      }),
      ...(turnId !== undefined && { turnId }),
      type: "follow-up",
    });
    return { deliveryId, queued: true };
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

/** Who a follow-up acts for: the session's identity, no caller, or a principal. */
function authKey(auth: DeliverHookPayload["auth"]): string {
  if (auth === undefined) return "session";
  if (auth === null) return "none";
  return JSON.stringify(principalOf(auth));
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
  input: Omit<HookSendOptions, "turnPolicy"> & {
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
    ...(input.auth !== undefined && { auth: input.auth }),
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
