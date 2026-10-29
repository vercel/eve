import type { DeliverHookPayload } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import { getAdapterKind } from "#channel/adapter.js";
import { serializeFilePartsInMessage } from "#channel/send-input.js";
import { AuthKey, ChannelDeliveryKey, ChannelInstrumentationKey } from "#context/keys.js";
import { normalizeMessage } from "#harness/messages.js";
import {
  HOOK_CONTINUE_KEYS,
  type HookContext,
  type HookContinueOptions,
  type HookContinueResult,
  type HookEventKey,
} from "#public/definitions/hook.js";
import { principalOf } from "#execution/session/principal.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { MessageContent } from "#shared/message-content.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { TurnSettledData } from "#protocol/session-events/families/turn.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { continuationKey } from "../continuation.js";
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
  const continueTurn = (
    message: MessageContent,
    options: HookContinueOptions = {},
  ): HookContinueResult => {
    assertOpen("continue");
    // Intake drops what this drops, so a blank message would start a turn with no message.
    if (normalizeMessage(message) === undefined) {
      throw new TypeError(`Hook "${label}" called ctx.continue() without a message.`);
    }
    // `*` handlers receive it too, for every event; only a settled turn has a next turn.
    if (call.event.type !== "turn.settled") return { queued: false, reason: "not-settled" };
    const settledTurn = call.event.data as TurnSettledData;
    // A hook that cancelled the turn can redirect it; a person's cancel stops the session.
    const state = readReactionsState(ctx);
    const cancelledHere =
      settledTurn.outcome === "cancelled" &&
      state.cancelledTurnId === settledTurn.turnId &&
      state.cancelledBy === id;
    if (settledTurn.outcome !== "completed" && !cancelledHere) {
      return { queued: false, reason: "not-completed" };
    }
    const { turnId } = settledTurn;
    const queued = [
      ...requested.flatMap((command) =>
        command.type === "continue" && command.turnId === turnId ? [command.delivery] : [],
      ),
      ...(state.continuation?.turnId === turnId ? [state.continuation.delivery] : []),
    ];
    if (
      queued.some(({ deliveryMetadata }) =>
        deliveryMetadata?.some((entry) => entry.hook === call.slug),
      )
    ) {
      return { queued: false, reason: "already-queued" };
    }
    // One delivery acts for one principal, so continuations join only when they agree on it.
    if (queued.length > 0 && actsFor(ctx, queued[0]!.auth) !== actsFor(ctx, options.auth)) {
      return { queued: false, reason: "auth-conflict" };
    }
    requested.push({
      delivery: hookDelivery(ctx, {
        ...options,
        idempotencyKey: continuationKey(sessionId, turnId),
        message,
        slug: call.slug,
      }),
      turnId,
      type: "continue",
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
    // Only handlers whose key can continue get the method, as their types say.
    ...(HOOK_CONTINUE_KEYS[call.key as HookEventKey] === true && { continue: continueTurn }),
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

/** The principal a continuation's turn acts for: omitted `auth` keeps the session's identity. */
function actsFor(ctx: ContextContainer, auth: DeliverHookPayload["auth"]): string {
  return principalOf(auth === undefined ? ctx.get(AuthKey) : auth);
}

function agentOf(ctx: ContextContainer): HookContext["agent"] {
  const bundle = ctx.require(BundleKey);
  return { name: bundle.turnAgent.id, nodeId: bundle.nodeId };
}

/**
 * A hook's message as a delivery into its own session. It queues behind the running turn and
 * keeps the channel of the turn that settled, so the channel's `deliver` hook reads it like any
 * other message. Its source names the hook, from which intake notes for the model that no person
 * wrote it; the message and context stay as the hook passed them.
 */
function hookDelivery(
  ctx: ContextContainer,
  input: HookContinueOptions & {
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
        ...(input.context !== undefined && { context: input.context }),
        message: serializeFilePartsInMessage(input.message),
      },
    ],
    turnPolicy: "queue",
  };
}
