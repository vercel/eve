import {
  MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
  validateDeliveryIdempotencyKey,
} from "#channel/delivery-idempotency.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import { ChannelDeliveryKey } from "#context/keys.js";
import { createLogger } from "#internal/logging.js";
import type { HookContext, HookSendOptions } from "#public/definitions/hook.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { TurnSettledData } from "#protocol/session-events/families/turn.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
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

const log = createLogger("hooks");

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
  const send = (message: string, options: HookSendOptions = {}): void => {
    assertOpen("send");
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new TypeError(`Hook "${label}" called ctx.send() without a message.`);
    }
    const { type } = call.event;
    const settledTurn = type === "turn.settled" ? (call.event.data as TurnSettledData) : undefined;
    // Only a completed turn has a next turn to continue it; every other event is ineligible.
    if (settledTurn?.outcome !== "completed") {
      const on = settledTurn === undefined ? `"${type}"` : `a ${settledTurn.outcome} turn`;
      log.warn(
        `Hook "${label}" called ctx.send() on ${on}; only a completed "turn.settled" can send the next message, so it's ignored.`,
      );
      return;
    }
    validateDeliveryIdempotencyKey(options.idempotencyKey);
    // A long hook path can push the occurrence key past the delivery key limit.
    const sendKey =
      options.idempotencyKey ??
      (idempotencyKey.length <= MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH
        ? idempotencyKey
        : `${sessionId}:hook-send:${digestOf(idempotencyKey)}`);
    requested.push({
      delivery: hookDelivery(ctx, {
        auth: options.auth === undefined ? frame.session.auth.current : options.auth,
        context: options.context,
        idempotencyKey: sendKey,
        message,
        slug: call.slug,
      }),
      turnId: settledTurn.turnId,
      type: "send",
    });
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
 * other message.
 */
function hookDelivery(
  ctx: ContextContainer,
  input: {
    readonly auth: DeliverHookPayload["auth"];
    readonly context: readonly string[] | undefined;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly slug: string;
  },
): DeliverHookPayload {
  const channel = ctx.get(ChannelDeliveryKey);
  return {
    auth: input.auth,
    deliveryMetadata: [
      {
        channelKind: channel?.channelKind ?? "hook",
        channelName: channel?.channelName ?? "hook",
        deliveryId: crypto.randomUUID(),
        hook: input.slug,
        payloadIndex: 0,
      },
    ],
    idempotencyKey: input.idempotencyKey,
    kind: "deliver",
    payloads: [
      input.context === undefined
        ? { message: input.message }
        : { context: input.context, message: input.message },
    ],
    turnPolicy: "queue",
  };
}
