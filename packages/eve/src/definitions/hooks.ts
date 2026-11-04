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
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import { sessionAgent } from "#definitions/agent.js";
import { continuationKey } from "#definitions/continuation.js";
import {
  queueCommands,
  reportEffectFailure,
  takeIntents,
  type Command,
} from "#definitions/intents.js";
import { sessionFrameOf } from "#definitions/frame.js";
import { openMemos } from "#definitions/memos.js";
import {
  discardedByDeployment,
  keepMemos,
  mergeMemos,
  readDefinitionsState,
  type DefinitionsState,
  writeDefinitionsState,
} from "#definitions/state.js";
import type { CommitInput, Definition, Effect } from "./definition.js";

/**
 * An authored hook: after every commit, its handlers run once for each fact of their type, typed
 * handler first, then `*`. Its occurrence identifies the fact for external services that support
 * idempotency.
 */
export function hookDefinition(hook: ResolvedHookDefinition): Definition {
  const definition = { id: `hook:${hook.slug}`, label: hook.logicalPath };
  return {
    ...definition,
    contribute: (ctx) => ({
      effects: () =>
        (ctx.commit?.written ?? []).flatMap(({ event: written, position, progress, view }) => {
          const { meta, ...event } = written;
          // Streamed progress reaches a handler that names it, and never `*`.
          return (progress ? [event.type] : [event.type, "*"]).flatMap((key): Effect[] => {
            const handler = hook.events[key];
            if (handler === undefined) return [];
            return [
              {
                id: definition.id,
                run: () =>
                  runHandler({
                    at: meta?.at,
                    commit: ctx.commit!,
                    ctx: ctx.container as ContextContainer,
                    event,
                    handler: handler as (event: unknown, ctx: HookContext) => unknown,
                    key,
                    occurrence: `${position.line}.${position.index}`,
                    position,
                    definition,
                    signal: ctx.signal,
                    slug: hook.slug,
                    view,
                  }),
              },
            ];
          });
        }),
    }),
  };
}

async function runHandler(call: {
  readonly at: string | undefined;
  readonly commit: CommitInput;
  readonly ctx: ContextContainer;
  readonly event: Omit<SessionStreamEvent, "meta">;
  readonly handler: (event: unknown, ctx: HookContext) => unknown;
  readonly key: string;
  readonly occurrence: string;
  readonly position: HookContext["position"];
  readonly definition: { readonly id: string; readonly label: string };
  readonly signal: AbortSignal;
  readonly slug: string;
  readonly view: SessionTables;
}): Promise<void> {
  const { ctx, signal: abortSignal } = call;
  const { id, label } = call.definition;
  const base = buildCallbackContext();
  const frame = sessionFrameOf(ctx, { at: call.at, view: call.view });
  const sessionId = base.session.id;
  const idempotencyKey = `${sessionId}:${id}:${call.occurrence}:${call.key}`;
  const memoScope = `${id}#${call.key}`;
  let settled = false;
  const memos = openMemos({
    abortSignal,
    afterDeployment: discardedByDeployment(ctx, memoScope),
    kept: readDefinitionsState(ctx).memos?.[memoScope],
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
    const state = readDefinitionsState(ctx);
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
        ? call.commit.cancelBeforeTurn
        : undefined;
    if (beforeTurn === undefined) queueCommands(ctx, call.definition, idempotencyKey, requested);
    else
      for (const command of requested)
        if (command.type === "cancel") {
          // The turn opens after this commit; it's the hook's to continue once it settles.
          const deliveryIds = call.commit.written.flatMap(({ event }) =>
            event.type === "delivery.admitted" ? [event.data.deliveryId] : [],
          );
          writeDefinitionsState(ctx, {
            ...readDefinitionsState(ctx),
            cancelledOpening: { by: id, deliveryIds },
          });
          beforeTurn({
            hook: label,
            ...(command.reason !== undefined && { reason: command.reason }),
          });
        }
  } catch (error) {
    mergeMemos(ctx, memoScope, memos.used());
    reportEffectFailure(ctx, call.definition, error, idempotencyKey);
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
  const agent = sessionAgent(ctx);
  return { name: agent.id, nodeId: agent.nodeId };
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

/** After a commit's effects: acts on the cancels hooks asked for, and drops what no longer holds. */
export function settleHookCommands(
  ctx: ContextContainer,
  definitions: readonly Definition[],
  input: {
    readonly written: readonly WrittenEvent[];
    readonly cancelTurn?: Parameters<typeof actOnCancels>[2];
  },
): void {
  actOnCancels(ctx, definitions, input.cancelTurn);
  dropYieldedContinuations(ctx, input.written);
}

/**
 * Stops the running turn for the first cancel that targets it, and drops cancels and failures
 * whose turn has ended. One the commit can't act on waits for a commit that can, while its turn
 * still runs.
 */
function actOnCancels(
  ctx: ContextContainer,
  definitions: readonly Definition[],
  cancelTurn: ((cancel: { readonly hook: string; readonly reason?: string }) => void) | undefined,
): void {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  takeIntents(
    ctx,
    (intent) => (intent.type === "cancel" || intent.type === "fail") && intent.turnId !== turnId,
  );
  const [first] = (readDefinitionsState(ctx).intents ?? []).filter(
    (intent) => intent.type === "cancel",
  );
  if (first === undefined || cancelTurn === undefined) return;
  const hook = definitions.find(({ id }) => id === first.reactionId)?.label ?? first.reactionId;
  takeIntents(ctx, (intent) => intent.type === "cancel");
  writeDefinitionsState(ctx, {
    ...readDefinitionsState(ctx),
    cancelledBy: first.reactionId,
    cancelledTurnId: first.turnId,
  });
  cancelTurn({ hook, ...(first.reason !== undefined && { reason: first.reason }) });
}

/**
 * A hook's continuation yields: once another turn starts, a cancel or reset arrives, or the
 * history is cleared, the session no longer continues the turn it was queued for, and it's dropped.
 * A compaction keeps it: the conversation it continues is still there, summarized.
 */
function dropYieldedContinuations(ctx: ContextContainer, written: readonly WrittenEvent[]): void {
  const { continuation, ...state } = readDefinitionsState(ctx);
  if (continuation === undefined) return;
  const latestTurnId = latestTurnIdOf(currentProjection(ctx));
  if (
    continuation.turnId === latestTurnId &&
    !written.some(({ event }) => stopsContinuations(event))
  ) {
    return;
  }
  writeDefinitionsState(ctx, state);
}

function stopsContinuations(event: WrittenEvent["event"]): boolean {
  if (event.type === "context.settled") {
    return event.data.kind === "clear" && event.data.outcome === "completed";
  }
  if (event.type !== "delivery.admitted") return false;
  const { source } = event.data;
  return (
    source !== undefined &&
    "control" in source &&
    (source.control === "cancel" || source.control === "reset")
  );
}

/**
 * A cancel from a hook before its turn opened stops the turn its input opens. The next turn to
 * start is that turn only if one of the cancelled deliveries caused it; input the session ignored
 * opens no turn, so an unrelated turn just clears the record. Bound before the commit's hooks
 * see the turn settle.
 */
export function bindOpeningCancel(
  state: DefinitionsState,
  written: readonly WrittenEvent[],
): DefinitionsState {
  const { cancelledOpening, ...rest } = state;
  if (cancelledOpening === undefined) return state;
  const started = written.find(({ event }) => event.type === "turn.started")?.event;
  if (started?.type !== "turn.started") return state;
  const { cause, turnId } = started.data;
  const opened = "deliveryId" in cause && cancelledOpening.deliveryIds.includes(cause.deliveryId);
  return opened ? { ...rest, cancelledBy: cancelledOpening.by, cancelledTurnId: turnId } : rest;
}
