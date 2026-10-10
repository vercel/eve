import type { ModelMessage } from "ai";

import { getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionPredecessorKey,
} from "#context/keys.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import type { ReactionView, SelectContext } from "#dynamic/definition.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import { currentProjection, currentView } from "#harness/session-machine/current.js";
import { createLogger } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { bundleReactions } from "./bundle.js";
import { effectiveModelId } from "./kinds/model.js";
import {
  REACTION_ORDER,
  type BundleReactions,
  type InternalResolveContext,
  type Reaction,
  type ReactionKind,
} from "./reaction.js";
import {
  canonicalJson,
  clearLive,
  digestOf,
  readLive,
  readReactionsState,
  type ReactionsState,
  type Slot,
  writeLive,
  writeReactionsState,
} from "./state.js";
import { pendingIntents, satisfyIntents } from "./kinds/hook.js";

const log = createLogger("reactions");
const neverAborted = new AbortController().signal;

/** Thrown by `view.messages` in a step without the conversation; the runner skips that reaction. */
const CONVERSATION_UNAVAILABLE = Symbol("eve.reactions.conversation-unavailable");
/** The digest a slot keeps when its `select` threw, so the failure logs once. */
const SELECT_FAILED = "select-failed";

export interface RunReactionsInput {
  readonly written: readonly WrittenEvent[];
  readonly abortSignal?: AbortSignal;
  /** The conversation as of this commit, or `undefined` in a step that doesn't hold it. */
  readonly conversation?: readonly ModelMessage[];
  /** Stops the running turn; absent when this commit can't stop one. */
  readonly cancelTurn?: (cancel: { readonly hook: string; readonly reason?: string }) => void;
}

/**
 * Runs after every commit: each reaction's `select` reads the view, and `resolve` runs only when
 * the selection changed since its slot was written. Slots change nothing else, so this settles.
 */
export async function runReactions(ctx: ContextContainer, input: RunReactionsInput): Promise<void> {
  const { reactions, effects } = await bundleReactions(ctx);
  writeReactionsState(ctx, withLatest(readReactionsState(ctx), input.written));
  // A compaction that starts satisfies every compact intent waiting for one.
  if (startsCompaction(input.written)) {
    writeReactionsState(
      ctx,
      satisfyIntents(readReactionsState(ctx), pendingIntents(ctx, "compact")),
    );
  }
  if (reactions.length === 0) return;
  const line = input.written.at(-1)?.position.line ?? readReactionsState(ctx).latest["*"] ?? 0;
  const selectContext = selectContextOf(ctx);
  const revision = readReactionsState(ctx).revision;
  const changedKinds = new Set<ReactionKind>();
  const changedHooks = new Set<string>();

  for (const reaction of reactions) {
    if (reaction.conversation === true && input.conversation === undefined) continue;
    let selection: JsonValue;
    try {
      selection = selectionOf(
        reaction,
        reactionView(ctx, reaction.kind, input.conversation),
        selectContext,
      );
    } catch (error) {
      if (error === CONVERSATION_UNAVAILABLE) continue;
      const failed = { digest: SELECT_FAILED, line, revision };
      if (withdraw(ctx, reaction, error, failed)) changedKinds.add(reaction.kind);
      continue;
    }
    const digest = digestOf(selection);
    const slot = readReactionsState(ctx).slots[reaction.id];
    if (slot !== undefined && slot.digest === digest && !staleUnder(slot, revision)) continue;
    const changed = await resolveInto(ctx, reaction, {
      abortSignal: input.abortSignal,
      conversation: input.conversation,
      digest,
      line,
      revision,
      selection,
      written: input.written,
    });
    if (!changed) continue;
    changedKinds.add(reaction.kind);
    if (reaction.kind === "hook") changedHooks.add(reaction.id);
  }

  for (const kind of changedKinds) await effects[kind]?.(ctx);
  actOnCancels(ctx, reactions, changedHooks, input.cancelTurn);
}

/**
 * Stops the running turn for the first cancel intent that targets it. The intent is satisfied
 * once the turn stops, so it acts once; one the commit can't act on waits for a commit that can,
 * while its turn still runs.
 */
function actOnCancels(
  ctx: ContextContainer,
  reactions: readonly Reaction[],
  changedHooks: ReadonlySet<string>,
  cancelTurn: RunReactionsInput["cancelTurn"],
): void {
  const turnId = currentProjection(ctx).activeTurnId;
  const pending = pendingIntents(ctx, "cancel").filter(({ intent }) => intent.turnId === turnId);
  const [first] = pending;
  if (first === undefined) return;
  const hook = reactions.find(({ id }) => id === first.reactionId)?.label ?? first.reactionId;
  if (cancelTurn === undefined) {
    if (pending.some(({ reactionId }) => changedHooks.has(reactionId))) {
      log.warn("A hook's cancel() waits: this commit cannot stop the running turn", { hook });
    }
    return;
  }
  writeReactionsState(ctx, satisfyIntents(readReactionsState(ctx), pending));
  cancelTurn({ hook, ...(first.intent.reason === undefined ? {} : { reason: first.intent.reason }) });
}

function startsCompaction(written: readonly WrittenEvent[]): boolean {
  return written.some(
    ({ event }) =>
      event.type === "context.started" &&
      (event.data as { readonly kind?: string }).kind === "compaction",
  );
}

/**
 * Rebuilds the code of every slot that carries some, for a step in a process that didn't build it:
 * `resolve` runs again with the selection the slot recorded. `revision` is the runtime revision the
 * step runs; slots resolved under another resolve again after the step's first commit.
 */
export async function restoreReactions(
  ctx: ContextContainer,
  input: { readonly abortSignal?: AbortSignal; readonly revision?: string } = {},
): Promise<void> {
  if (input.revision !== undefined) {
    writeReactionsState(ctx, { ...readReactionsState(ctx), revision: input.revision });
  }
  const { reactions } = await bundleReactions(ctx);
  for (const reaction of reactions) {
    const slot = readSlot(ctx, reaction.id);
    if (slot?.selection === undefined || readLive(ctx, reaction.id, slot) !== undefined) continue;
    const rctx = resolveContextOf(ctx, {
      abortSignal: input.abortSignal,
      previous: slot,
      written: [],
    });
    try {
      const contribution = await reaction.contribute(
        await reaction.resolve(slot.selection, rctx),
        rctx,
      );
      const value = parseJsonValue(contribution.value ?? null);
      let restored = slot;
      let live = contribution.live;
      if (canonicalJson(value) !== canonicalJson(slot.value)) {
        log.warn("A reaction rebuilt from its recorded selection returned something different", {
          reaction: reaction.label,
        });
        if (reaction.reconcile === undefined) {
          restored = { ...slot, value };
          writeSlot(ctx, reaction.id, restored);
        } else {
          live = reaction.reconcile(slot.value, { live, value });
        }
      }
      if (live !== undefined) writeLive(ctx, reaction.id, restored, live);
    } catch (error) {
      if (reaction.failure === "throw") throw error;
      withdraw(ctx, reaction, error, {
        digest: slot.digest,
        line: slot.since,
        revision: slot.revision,
      });
    }
  }
}

/** Applies every kind's slots to the step's process-local state, such as its connection registry. */
export async function applyReactionEffects(ctx: ContextContainer): Promise<void> {
  const { effects } = await bundleReactions(ctx);
  for (const effect of Object.values(effects)) await effect(ctx);
}

/** The slots of one kind, in run order, with their live contributions where this process has them. */
export function slotsOf(
  ctx: Parameters<typeof readReactionsState>[0],
  kind: ReactionKind,
): readonly { readonly id: string; readonly slot: Slot; readonly live?: unknown }[] {
  if (ctx === undefined) return [];
  const prefix = `${kind}:`;
  return Object.entries(readReactionsState(ctx).slots)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, slot]) => {
      const live = readLive(ctx, id, slot);
      return live === undefined ? { id, slot } : { id, live: live.live, slot };
    });
}

export function readSlot(
  ctx: Parameters<typeof readReactionsState>[0],
  id: string,
): Slot | undefined {
  return readReactionsState(ctx).slots[id];
}

function writeSlot(ctx: ContextContainer, id: string, slot: Slot | undefined): void {
  const state = readReactionsState(ctx);
  const slots = { ...state.slots };
  if (slot === undefined) delete slots[id];
  else slots[id] = slot;
  writeReactionsState(ctx, { ...state, slots });
}

/**
 * Whether a new runtime revision must resolve the slot again. Only slots with code, which another
 * revision's code built, and failed slots, which new code may fix, do. A data slot keeps its value
 * until its selection changes, so a redeploy doesn't re-run every reaction in every session; data
 * that changed code would produce differently stays as it was until then.
 */
function staleUnder(slot: Slot, revision: string | undefined): boolean {
  if (revision === undefined || slot.revision === revision) return false;
  return slot.selection !== undefined || slot.error !== undefined;
}

/** Records a contribution; returns whether the slot's contribution changed. */
async function resolveInto(
  ctx: ContextContainer,
  reaction: Reaction,
  run: {
    readonly abortSignal: AbortSignal | undefined;
    readonly conversation: readonly ModelMessage[] | undefined;
    readonly digest: string;
    readonly line: number;
    readonly revision: string | undefined;
    readonly selection: JsonValue;
    readonly written: readonly WrittenEvent[];
  },
): Promise<boolean> {
  const previous = readSlot(ctx, reaction.id);
  const rctx = resolveContextOf(ctx, {
    abortSignal: run.abortSignal,
    messages: reaction.conversation === true ? run.conversation : undefined,
    previous,
    written: run.written,
  });
  let value: JsonValue;
  let live: unknown;
  try {
    const contribution = await reaction.contribute(
      await reaction.resolve(run.selection, rctx),
      rctx,
    );
    value = parseJsonValue(contribution.value ?? null);
    live = contribution.live;
  } catch (error) {
    if (reaction.failure === "throw") throw error;
    return withdraw(ctx, reaction, error, run);
  }
  const unchanged =
    previous !== undefined && canonicalJson(previous.value) === canonicalJson(value);
  const slot: Slot = {
    digest: run.digest,
    since: unchanged ? previous.since : run.line,
    value,
    ...(live === undefined ? {} : { selection: run.selection }),
    ...(run.revision === undefined ? {} : { revision: run.revision }),
  };
  writeSlot(ctx, reaction.id, slot);
  if (live === undefined) clearLive(ctx, reaction.id);
  else writeLive(ctx, reaction.id, slot, live);
  return !unchanged;
}

/**
 * A throw withdraws the slot's contribution; the kind's readers then see nothing from it. The slot
 * keeps the failed selection's digest, so the reaction retries when its selection or the runtime
 * revision changes rather than on every commit.
 */
function withdraw(
  ctx: ContextContainer,
  reaction: Reaction,
  error: unknown,
  failed: { readonly digest: string; readonly line: number; readonly revision?: string },
): boolean {
  const previous = readSlot(ctx, reaction.id);
  if (previous?.digest !== failed.digest || previous.value !== null) {
    log.error(`Reaction "${reaction.label}" failed; its contribution is withdrawn.`, {
      error: toErrorMessage(error),
      kind: reaction.kind,
    });
  }
  const had = previous !== undefined && previous.value !== null;
  writeSlot(ctx, reaction.id, {
    digest: failed.digest,
    error: toErrorMessage(error),
    since: had ? failed.line : (previous?.since ?? failed.line),
    value: null,
    ...(failed.revision === undefined ? {} : { revision: failed.revision }),
  });
  clearLive(ctx, reaction.id);
  return had;
}

function selectionOf(reaction: Reaction, view: ReactionView, ctx: SelectContext): JsonValue {
  if (reaction.select === undefined) return null;
  const selected = reaction.select(view, ctx);
  try {
    return parseJsonValue(selected ?? null);
  } catch {
    throw new Error(`The select of "${reaction.label}" must return JSON.`);
  }
}

function withLatest(state: ReactionsState, written: readonly WrittenEvent[]): ReactionsState {
  if (written.length === 0) return state;
  const latest = { ...state.latest };
  for (const { event, position, progress } of written) {
    latest[event.type] = position.line;
    if (!progress) latest["*"] = position.line;
    if (event.type === "context.started" || event.type === "context.settled") {
      latest[`${event.type}:${(event.data as { readonly kind?: string }).kind ?? ""}`] =
        position.line;
    }
  }
  return { ...state, latest };
}

/** Kinds that run before the model this commit, so can't read the model it chooses. */
const BEFORE_MODEL = new Set<ReactionKind>(
  REACTION_ORDER.slice(0, REACTION_ORDER.indexOf("model") + 1),
);

/**
 * The view a reaction of `kind` selects from. It holds only what earlier kinds have contributed
 * this commit: a kind that runs before the model, or the model itself, would otherwise read the
 * previous commit's model.
 */
function reactionView(
  ctx: ContextContainer,
  kind: ReactionKind,
  conversation: readonly ModelMessage[] | undefined,
): ReactionView {
  const latest = readReactionsState(ctx).latest;
  return Object.defineProperties(
    { ...currentView(ctx) },
    {
      latest: { enumerable: true, value: latest },
      messages: {
        enumerable: true,
        get() {
          if (conversation === undefined) throw CONVERSATION_UNAVAILABLE;
          return conversation;
        },
      },
      model: {
        enumerable: true,
        get() {
          if (BEFORE_MODEL.has(kind)) {
            throw new Error(
              `view.model isn't available to a ${kind} reaction: it runs before the model is chosen. Select the model from a capability instead.`,
            );
          }
          const id = effectiveModelId(ctx);
          return id === undefined ? null : { id };
        },
      },
    },
  ) as ReactionView;
}

export function selectContextOf(ctx: Pick<ContextContainer, "get">): SelectContext {
  const channel = ctx.get(ChannelKey);
  const conversation = ctx.get(ConversationContextKey);
  return {
    channel: {
      continuationToken: ctx.get(ContinuationTokenKey),
      kind: channel === undefined ? undefined : getAdapterKind(channel),
      metadata: ctx.get(ChannelInstrumentationKey)?.metadata,
    },
    ...(conversation === undefined ? {} : { conversation }),
    session: {
      auth: { current: ctx.get(AuthKey) ?? null, initiator: ctx.get(InitiatorAuthKey) ?? null },
      id: ctx.get(SessionIdKey) ?? "",
      predecessor: ctx.get(SessionPredecessorKey),
      schedule: readSessionSchedule(ctx),
    },
  };
}

function resolveContextOf(
  ctx: ContextContainer,
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly messages?: readonly ModelMessage[];
    readonly previous: Slot | undefined;
    readonly written: readonly WrittenEvent[];
  },
): InternalResolveContext {
  return {
    ...selectContextOf(ctx),
    abortSignal: input.abortSignal ?? neverAborted,
    ctx,
    facts: input.written.map(({ event }) => event),
    ...(input.messages === undefined ? {} : { messages: input.messages }),
    ...(input.previous === undefined ? {} : { previous: input.previous }),
    written: input.written,
  };
}

export type { BundleReactions };
