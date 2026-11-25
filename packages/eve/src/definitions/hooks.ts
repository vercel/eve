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

export function hookDefinition(hook: ResolvedHookDefinition): Definition {
  const definition = { id: `hook:${hook.slug}`, label: hook.logicalPath };
  return {
    ...definition,
    contribute: (ctx) => ({
      effects: () =>
        (ctx.commit?.written ?? []).flatMap(({ event: written, position, progress, view }) => {
          const { meta, ...event } = written;
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
  const end = (reason?: string): void => {
    assertOpen("end");
    if (call.event.type === "session.ended") return;
    requested.push(
      reason === undefined
        ? { hook: call.slug, type: "end" }
        : { hook: call.slug, reason, type: "end" },
    );
  };
  const continueTurn = (
    message: MessageContent,
    options: HookContinueOptions = {},
  ): HookContinueResult => {
    assertOpen("continue");
    if (normalizeMessage(message) === undefined) {
      throw new TypeError(`Hook "${label}" called ctx.continue() without a message.`);
    }
    if (call.event.type !== "turn.settled") return { queued: false, reason: "not-settled" };
    const settledTurn = call.event.data as TurnSettledData;
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
    end,
    memo: memos.memo,
    occurrence: { abortSignal, idempotencyKey },
    position: call.position,
    session: { ...base.session, ...frame.session },
    ...(HOOK_CONTINUE_KEYS[call.key as HookEventKey] === true && { continue: continueTurn }),
  };
  try {
    await call.handler(call.event, hookContext);
    keepMemos(ctx, memoScope, memos.used());
    settled = true;
    const beforeTurn =
      (call.event.type === "delivery.admitted" || call.event.type === "session.started") &&
      activeTurnIdOf(currentProjection(ctx)) === undefined
        ? call.commit.cancelBeforeTurn
        : undefined;
    if (beforeTurn === undefined) {
      queueCommands(ctx, call.definition, idempotencyKey, requested);
    } else {
      const endCommand = requested.find(
        (command): command is Extract<Command, { readonly type: "end" }> => command.type === "end",
      );
      if (endCommand !== undefined) {
        queueCommands(ctx, call.definition, idempotencyKey, [endCommand]);
        beforeTurn({
          hook: label,
          ...(endCommand.reason !== undefined && { reason: endCommand.reason }),
        });
      } else if (call.event.type === "delivery.admitted") {
        for (const command of requested)
          if (command.type === "cancel") {
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
      }
    }
  } catch (error) {
    mergeMemos(ctx, memoScope, memos.used());
    reportEffectFailure(ctx, call.definition, error, idempotencyKey);
  } finally {
    settled = true;
    memos.close();
  }
}

function actsFor(ctx: ContextContainer, auth: DeliverHookPayload["auth"]): string {
  return principalOf(auth === undefined ? ctx.get(AuthKey) : auth);
}

function agentOf(ctx: ContextContainer): HookContext["agent"] {
  const agent = sessionAgent(ctx);
  return { name: agent.id, nodeId: agent.nodeId };
}

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

function dropYieldedContinuations(ctx: ContextContainer, written: readonly WrittenEvent[]): void {
  const { continuation, ...state } = readDefinitionsState(ctx);
  if (continuation === undefined) return;
  const latestTurnId = latestTurnIdOf(currentProjection(ctx));
  if (
    state.sessionEnd === undefined &&
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
