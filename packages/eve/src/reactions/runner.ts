import type { ModelMessage } from "ai";

import type { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { bundleReactions } from "./bundle.js";
import { sessionFrameOf } from "./frame.js";
import { reportReactionFailure, takeIntents } from "./intents.js";
import { HARNESS_INSTRUCTIONS } from "./kinds/instructions.js";
import { effectiveModelId, HARNESS_MODEL_ID } from "./kinds/model.js";
import { HARNESS_TOOLS } from "./kinds/tool.js";
import type {
  BundleReactions,
  CommitReaction,
  CommitContext,
  InternalContext,
  Reaction,
  ValueReaction,
} from "./reaction.js";
import { requireHistory } from "./reaction.js";
import { openMemos } from "./records.js";
import {
  clearLive,
  digestOf,
  discardedByDeployment,
  forgetSessionLive,
  keepMemos,
  mergeMemos,
  readLive,
  readReactionsState,
  readSlot,
  sessionIdOf,
  type ReactionsState,
  type Slot,
  writeLive,
  writeReactionsState,
} from "./state.js";

// Two schedules. Hooks, and eve's own effects such as memory capture, run after every commit, so
// they notice a change when it happens. Dynamic values are functions of the session, evaluated in
// each step that needs them: before each model call, with the conversation that call reads, and
// where a step needs a value's code that this process hasn't built. A value that fails fails the
// turn, and keeps nothing but the memos that succeeded.

const log = createLogger("reactions");
const neverAborted = new AbortController().signal;

export interface RunReactionsInput {
  readonly written: readonly WrittenEvent[];
  readonly abortSignal?: AbortSignal;
  /** The conversation as of this commit, or `undefined` in a step that doesn't hold it. */
  readonly conversation?: readonly ModelMessage[];
  /** Stops the running turn; absent when this commit can't stop one. */
  readonly cancelTurn?: CommitContext["cancelBeforeTurn"];
  readonly cancelBeforeTurn?: CommitContext["cancelBeforeTurn"];
}

/** Runs after every commit: hooks' handlers for the commit's facts, then eve's own effects. */
export async function runReactions(ctx: ContextContainer, input: RunReactionsInput): Promise<void> {
  const { reactions } = await bundleReactions(ctx);
  writeReactionsState(
    ctx,
    bindOpeningCancel(withLatest(readReactionsState(ctx), input.written), input.written),
  );
  const onCommit = reactions.filter(
    (reaction): reaction is CommitReaction => reaction.timing === "commit",
  );
  if (onCommit.length === 0 || input.written.length === 0) return;
  let cancelBeforeTurn: (() => void) | undefined;
  const beforeTurn = input.cancelBeforeTurn;
  const context: CommitContext = {
    cancelBeforeTurn:
      beforeTurn === undefined
        ? undefined
        : (cancel) => {
            cancelBeforeTurn ??= () => beforeTurn(cancel);
          },
    abortSignal: input.abortSignal ?? neverAborted,
    ctx,
    facts: input.written.map(({ event }) => event),
    history: input.conversation,
    written: input.written,
  };
  for (const reaction of onCommit) {
    // Streamed progress reaches the hooks that handle it, and nothing else.
    if (reaction.kind !== "hook" && input.written.every(({ progress }) => progress)) continue;
    try {
      await reaction.onCommit(context);
    } catch (error) {
      reportReactionFailure(ctx, reaction, error);
    }
  }
  actOnCancels(ctx, reactions, input.cancelTurn);
  dropYieldedContinuations(ctx, input.written);
  cancelBeforeTurn?.();
}

/** A dynamic value failed to evaluate before a model call: the turn fails. */
export class ReactionFailedError extends Error {
  override readonly name = "ReactionFailedError";
  readonly reaction: string;

  constructor(reaction: string, error: unknown) {
    super(toErrorMessage(error), { cause: error });
    this.reaction = reaction;
  }
}

export function isReactionFailedError(error: unknown): error is ReactionFailedError {
  return error instanceof ReactionFailedError;
}

/**
 * Evaluates the session's dynamic values before a model call, with the conversation it reads,
 * and installs what they return. Throws {@link ReactionFailedError} for the first value that
 * fails.
 */
export async function evaluateValues(
  ctx: ContextContainer,
  input: {
    readonly abortSignal?: AbortSignal;
    readonly conversation: readonly ModelMessage[];
  },
): Promise<void> {
  const { reactions, effects } = await bundleReactions(ctx);
  const changed = new Set<Reaction["kind"]>();
  const run = async (reaction: ValueReaction) => {
    const started = Date.now();
    let result: { readonly changed: boolean };
    try {
      result = await evaluate(ctx, reaction, { ...input, mode: "evaluate" });
    } catch (error) {
      throw failed(reaction, error);
    }
    if (result.changed) changed.add(reaction.kind);
    log.debug("Evaluated a dynamic value", {
      changed: result.changed,
      durationMs: Date.now() - started,
      reaction: reaction.label,
    });
  };
  const lazy = values(reactions).filter((reaction) => reaction.declared === true);
  let declared: Promise<void> | undefined;
  const ensure = () =>
    (declared ??= (async () => {
      for (const reaction of lazy) await run(reaction);
    })());
  pendingDeclared.set(ctx, ensure);
  try {
    for (const reaction of values(reactions)) {
      if (reaction.declared !== true) await run(reaction);
    }
    if (lazy.length > 0 && leftToEve(ctx)) await ensure();
  } finally {
    pendingDeclared.delete(ctx);
  }
  for (const kind of changed) await effects[kind]?.(ctx);
}

/**
 * What the agent's files declare, while the step's values evaluate: once, when first asked.
 * Process-wide, since an agent's bundled code holds its own copy of this module.
 */
const pendingDeclared: WeakMap<ContextContainer, () => Promise<void>> = ((
  globalThis as Record<symbol, unknown>
)[Symbol.for("eve.reactions.pendingDeclared")] ??= new WeakMap()) as never;

/**
 * Evaluates what the agent's files declare, where a harness asks for it while the step's values
 * evaluate. Elsewhere, the slots hold what the latest evaluation left.
 */
export async function evaluateDeclared(ctx: ContextContainer): Promise<void> {
  await pendingDeclared.get(ctx)?.();
}

/** A harness field left to eve needs what the agent's files declare. */
function leftToEve(ctx: ContextContainer): boolean {
  const { slots } = readReactionsState(ctx);
  return [HARNESS_MODEL_ID, HARNESS_TOOLS, HARNESS_INSTRUCTIONS].some(
    (id) => slots[id] === undefined || slots[id].value === null,
  );
}

function failed(reaction: Reaction, error: unknown): ReactionFailedError {
  log.error(`Dynamic value "${reaction.label}" failed; the turn fails.`, {
    error: toErrorMessage(error),
    kind: reaction.kind,
  });
  return new ReactionFailedError(reaction.label, error);
}

/**
 * Prepares a step: on a move to another deployment, discards memos; drops the slots of
 * definitions the bundle no longer has; and evaluates again each value whose code this process
 * doesn't hold, so a step that runs a tool call or reaches a connection before its model call
 * has them. Its memos return what they kept, so this asks nothing of the outside world again.
 */
export async function restoreReactions(
  ctx: ContextContainer,
  input: {
    readonly abortSignal?: AbortSignal;
    readonly conversation?: readonly ModelMessage[];
    readonly revision?: string;
  } = {},
): Promise<void> {
  const before = readReactionsState(ctx);
  if (input.revision !== undefined && input.revision !== before.revision) {
    const moved = before.revision !== undefined && before.memos !== undefined;
    if (moved) log.info("The session moved to another deployment; its memos run again.");
    const { memos, ...rest } = before;
    writeReactionsState(ctx, {
      ...(moved ? { ...rest, discarded: Object.keys(memos ?? {}) } : before),
      revision: input.revision,
    });
  }
  // Outside production, EVE_REACTIONS_COLD=1 makes every step build its code as a fresh process
  // would, which tests recovery without a restart. A deployment never reads it.
  if (process.env.NODE_ENV !== "production" && process.env.EVE_REACTIONS_COLD === "1") {
    const sessionId = ctx.get(SessionIdKey);
    if (sessionId !== undefined) forgetSessionLive(sessionId);
  }
  const { reactions } = await bundleReactions(ctx);
  dropRemovedSlots(ctx, reactions);
  for (const reaction of values(reactions)) {
    const slot = readSlot(ctx, reaction.id);
    if (slot?.live !== true || readLive(ctx, reaction.id, slot) !== undefined) continue;
    try {
      await evaluate(ctx, reaction, { ...input, mode: "restore" });
    } catch (error) {
      // The next model call evaluates it again, and fails the turn if it still fails.
      log.warn(`Dynamic value "${reaction.label}" didn't evaluate for this step.`, {
        error: toErrorMessage(error),
      });
    }
  }
}

/**
 * Drops the slots of definitions the bundle no longer has, such as a dynamic instruction file a
 * new deployment deleted, so readers that list a kind's slots stop offering what they held.
 */
function dropRemovedSlots(ctx: ContextContainer, reactions: readonly Reaction[]): void {
  const state = readReactionsState(ctx);
  const ids = new Set(reactions.map(({ id }) => id));
  const removed = Object.keys(state.slots).filter((id) => !ids.has(id));
  const removedMemos = Object.keys(state.memos ?? {}).filter(
    (scope) => !scope.startsWith(PROGRAM_SCOPE) && !ids.has(scope.split("#")[0]!),
  );
  if (removed.length === 0 && removedMemos.length === 0) return;
  const slots = { ...state.slots };
  for (const id of removed) {
    delete slots[id];
    clearLive(ctx, id);
  }
  const memos = { ...state.memos };
  for (const scope of removedMemos) delete memos[scope];
  writeReactionsState(ctx, { ...state, memos, slots });
}

/** Applies every kind's slots to the step's process-local state, such as its connection registry. */
export async function applyReactionEffects(ctx: ContextContainer): Promise<void> {
  const { effects } = await bundleReactions(ctx);
  for (const effect of Object.values(effects)) await effect(ctx);
}

function values(reactions: readonly Reaction[]): readonly ValueReaction[] {
  return reactions.filter((reaction): reaction is ValueReaction => reaction.timing !== "commit");
}

function writeSlot(ctx: ContextContainer, id: string, slot: Slot): void {
  const state = readReactionsState(ctx);
  writeReactionsState(ctx, { ...state, slots: { ...state.slots, [id]: slot } });
}

/**
 * Evaluates one definition and installs what it returns. Returns whether its kind's effects need
 * to run again: the value changed, or carries code, which the evaluation built anew. Throws
 * without changing the slot; the memos that ran are kept.
 */
async function evaluate(
  ctx: ContextContainer,
  reaction: ValueReaction,
  run: {
    readonly abortSignal?: AbortSignal;
    readonly conversation?: readonly ModelMessage[];
    readonly mode: "evaluate" | "restore";
  },
): Promise<{ readonly changed: boolean }> {
  const abortSignal = run.abortSignal ?? neverAborted;
  const { result: contribution, used } = await withMemos(
    ctx,
    { abortSignal, label: reaction.label, scope: reaction.id },
    async (memo) => {
      const context = internalContext(ctx, reaction, { ...run, abortSignal, memo });
      return await reaction.contribute(await reaction.evaluate(context), context);
    },
  );
  const value = parseJsonValue(contribution.value ?? null);
  const digest = digestOf(value);
  // In development, evaluate again with the memos fixed: a value that changes anyway depends on
  // something outside its memos, such as randomness or the time, and shows up now rather than
  // after a cold start in production.
  if (isEveDevEnvironment() && run.mode === "evaluate") {
    await checkStable(ctx, reaction, { ...run, abortSignal, digest, used });
  }
  const previous = readSlot(ctx, reaction.id);
  const unchanged = previous?.digest === digest;
  if (!unchanged && previous !== undefined && run.mode === "restore") {
    log.warn(
      `Dynamic value "${reaction.label}" offers something other than what the session was offered after a restart: code outside its memos answered differently. eve offers the new value from the next model call.`,
    );
  }
  const line = readReactionsState(ctx).latest["*"] ?? 0;
  const slot: Slot = {
    digest,
    since: unchanged ? previous.since : line,
    value,
    ...(contribution.live !== undefined && { live: true as const }),
  };
  writeSlot(ctx, reaction.id, slot);
  if (contribution.live === undefined) clearLive(ctx, reaction.id);
  else writeLive(ctx, reaction.id, slot, contribution.live);
  return { changed: !unchanged || contribution.live !== undefined };
}

/**
 * Runs `fn` with `scope`'s memos. When it succeeds, the scope keeps what this run used; when it
 * fails, what ran joins what the scope had.
 */
export async function withMemos<T>(
  ctx: ContextContainer,
  input: { readonly scope: string; readonly label: string; readonly abortSignal?: AbortSignal },
  fn: (memo: InternalContext["memo"]) => Promise<T>,
): Promise<{ readonly result: T; readonly used: Readonly<Record<string, JsonValue>> }> {
  const memos = openMemos({
    abortSignal: input.abortSignal ?? neverAborted,
    afterDeployment: discardedByDeployment(ctx, input.scope),
    kept: readReactionsState(ctx).memos?.[input.scope],
    label: input.label,
    scope: input.scope,
    sessionId: sessionIdOf(ctx),
  });
  let result: T;
  try {
    result = await fn(memos.memo);
  } catch (error) {
    mergeMemos(ctx, input.scope, memos.used());
    throw error;
  } finally {
    memos.close();
  }
  const used = memos.used();
  keepMemos(ctx, input.scope, used);
  return { result, used };
}

/** The memo scope of one of the harness policy's decisions, which no definition owns. */
export function policyScope(decision: "history" | "next"): string {
  return `${PROGRAM_SCOPE}${decision}`;
}

const PROGRAM_SCOPE = "program:";

/** Evaluates `reaction` again with its memos fixed, and reports a value that differs. */
async function checkStable(
  ctx: ContextContainer,
  reaction: ValueReaction,
  run: {
    readonly abortSignal: AbortSignal;
    readonly conversation?: readonly ModelMessage[];
    readonly digest: string;
    readonly used: Readonly<Record<string, JsonValue>>;
  },
): Promise<void> {
  const memos = openMemos({
    abortSignal: run.abortSignal,
    kept: run.used,
    label: reaction.label,
    restoring: "a second evaluation used a memo key the first didn't",
    scope: reaction.id,
    sessionId: sessionIdOf(ctx),
  });
  try {
    const context = internalContext(ctx, reaction, { ...run, memo: memos.memo });
    const again = await reaction.contribute(await reaction.evaluate(context), context);
    if (digestOf(parseJsonValue(again.value ?? null)) === run.digest) return;
    log.warn(
      `Dynamic value "${reaction.label}" returned something different when evaluated again with the same memos. Code outside a memo, such as Math.random() or Date.now() in a name or description, makes eve rebuild it before every model call; move it into a memo, or use ctx.now.`,
    );
  } catch (error) {
    log.warn(`Dynamic value "${reaction.label}" failed when evaluated again with the same memos.`, {
      error: toErrorMessage(error),
    });
  } finally {
    memos.close();
  }
}

function internalContext(
  ctx: ContextContainer,
  reaction: ValueReaction,
  run: {
    readonly abortSignal: AbortSignal;
    readonly conversation?: readonly ModelMessage[];
    readonly memo: InternalContext["memo"];
  },
): InternalContext {
  const frame = sessionFrameOf(ctx);
  const history = run.conversation;
  return Object.defineProperties(
    {
      ...frame,
      abortSignal: run.abortSignal,
      ctx,
      history,
      memo: run.memo,
      messages: async () => requireHistory({ history }, reaction.label),
    },
    {
      model: {
        enumerable: true,
        get() {
          if (reaction.kind === "model") {
            throw new Error(
              `"${reaction.label}" read ctx.model while choosing the model. The model field's function runs before the model is chosen.`,
            );
          }
          const id = effectiveModelId(ctx);
          if (id === undefined) {
            throw new Error(`"${reaction.label}" read ctx.model before the session chose one.`);
          }
          return { id };
        },
      },
    },
  ) as InternalContext;
}

/**
 * Stops the running turn for the first cancel that targets it, and drops cancels and failures
 * whose turn has ended. One the commit can't act on waits for a commit that can, while its turn
 * still runs.
 */
function actOnCancels(
  ctx: ContextContainer,
  reactions: BundleReactions["reactions"],
  cancelTurn: RunReactionsInput["cancelTurn"],
): void {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  takeIntents(
    ctx,
    (intent) => (intent.type === "cancel" || intent.type === "fail") && intent.turnId !== turnId,
  );
  const [first] = (readReactionsState(ctx).intents ?? []).filter(
    (intent) => intent.type === "cancel",
  );
  if (first === undefined || cancelTurn === undefined) return;
  const hook = reactions.find(({ id }) => id === first.reactionId)?.label ?? first.reactionId;
  takeIntents(ctx, (intent) => intent.type === "cancel");
  writeReactionsState(ctx, {
    ...readReactionsState(ctx),
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
  const { continuation, ...state } = readReactionsState(ctx);
  if (continuation === undefined) return;
  const latestTurnId = latestTurnIdOf(currentProjection(ctx));
  if (
    continuation.turnId === latestTurnId &&
    !written.some(({ event }) => stopsContinuations(event))
  ) {
    return;
  }
  writeReactionsState(ctx, state);
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
function bindOpeningCancel(
  state: ReactionsState,
  written: readonly WrittenEvent[],
): ReactionsState {
  const { cancelledOpening, ...rest } = state;
  if (cancelledOpening === undefined) return state;
  const started = written.find(({ event }) => event.type === "turn.started")?.event;
  if (started?.type !== "turn.started") return state;
  const { cause, turnId } = started.data;
  const opened = "deliveryId" in cause && cancelledOpening.deliveryIds.includes(cause.deliveryId);
  return opened ? { ...rest, cancelledBy: cancelledOpening.by, cancelledTurnId: turnId } : rest;
}

function withLatest(state: ReactionsState, written: readonly WrittenEvent[]): ReactionsState {
  if (written.length === 0) return state;
  const latest = { ...state.latest };
  let at = state.at;
  for (const { event, position, progress } of written) {
    latest[event.type] = position.line;
    if (progress) continue;
    latest["*"] = position.line;
    at = event.meta?.at ?? at;
    if (event.type === "context.started" || event.type === "context.settled") {
      latest[`${event.type}:${(event.data as { readonly kind?: string }).kind ?? ""}`] =
        position.line;
    }
  }
  return { ...state, latest, ...(at !== undefined && { at }) };
}

export type { BundleReactions };
