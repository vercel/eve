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
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { bundleReactions } from "./bundle.js";
import { effectiveModelId } from "./kinds/model.js";
import {
  CONVERSATION_UNAVAILABLE,
  REACTION_ORDER,
  type BundleReactions,
  type InternalRecordContext,
  type Reaction,
  type ReactionKind,
} from "./reaction.js";
import {
  canonicalJson,
  clearLive,
  digestOf,
  forgetSessionLive,
  readLive,
  readReactionsState,
  readSlot,
  type ReactionsState,
  type Slot,
  writeLive,
  writeReactionsState,
} from "./state.js";
import { reportReactionFailure, takeIntents } from "./intents.js";
import { latestTurn } from "./turn.js";

// Two schedules. Hooks, and eve's own effects such as memory capture, run after every commit, so
// they notice a change when it happens. Dynamic values are evaluated before each model call, with
// the conversation that call reads, and fix the model, tools, and context it uses. A value that
// fails isn't recorded: the last good record stands, and the next model call evaluates it again.

const log = createLogger("reactions");
const neverAborted = new AbortController().signal;

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
 * Runs after every commit: each hook's `select` reads the view, and `run` acts only when the
 * selection changed since its slot was written, once per occurrence.
 */
export async function runReactions(ctx: ContextContainer, input: RunReactionsInput): Promise<void> {
  const { reactions, effects } = await bundleReactions(ctx);
  writeReactionsState(ctx, withLatest(readReactionsState(ctx), input.written));
  // A compaction that starts acts on every compact intent waiting for one.
  if (startsCompaction(input.written)) takeIntents(ctx, (intent) => intent.type === "compact");
  const onCommit = reactions.filter((reaction) => reaction.timing === "commit");
  if (onCommit.length === 0) return;
  const line = input.written.at(-1)?.position.line ?? readReactionsState(ctx).latest["*"] ?? 0;
  const selectContext = selectContextOf(ctx);
  const changedKinds = new Set<ReactionKind>();
  const changedHooks = new Set<string>();
  // Streamed progress, such as content deltas, reaches hooks that handle it, and nothing else.
  const progressOnly = input.written.length > 0 && input.written.every(({ progress }) => progress);

  for (const reaction of onCommit) {
    if (progressOnly && reaction.kind !== "hook") continue;
    let selection: JsonValue;
    try {
      selection = selectionOf(
        reaction,
        reactionView(ctx, reaction.kind, input.conversation),
        selectContext,
      );
    } catch (error) {
      // A select that reads the conversation runs where the step holds it; it's pure, so
      // skipping it repeats no work.
      if (error === CONVERSATION_UNAVAILABLE) continue;
      const slot = readSlot(ctx, reaction.id);
      if (slot?.digest === SELECT_FAILED) continue;
      writeSlot(ctx, reaction.id, failedSlot(slot, SELECT_FAILED, line, error));
      reportReactionFailure(ctx, reaction, error);
      continue;
    }
    const digest = digestOf(selection);
    const slot = readSlot(ctx, reaction.id);
    if (slot !== undefined && slot.digest === digest) continue;
    const occurrence = (slot?.occurrence ?? 0) + 1;
    try {
      const result = await evaluate(ctx, reaction, {
        abortSignal: input.abortSignal,
        conversation: input.conversation,
        digest,
        line,
        occurrence,
        selection,
        written: input.written,
      });
      if (result.changed) changedKinds.add(reaction.kind);
      if (reaction.kind === "hook") changedHooks.add(reaction.id);
    } catch (error) {
      // A failed occurrence isn't run again: a compaction meant for an idle moment shouldn't
      // happen later. The workflow's own retry of the step still runs it again.
      writeSlot(ctx, reaction.id, { ...failedSlot(slot, digest, line, error), occurrence });
      reportReactionFailure(ctx, reaction, error);
    }
  }

  for (const kind of changedKinds) await effects[kind]?.(ctx);
  actOnCancels(ctx, reactions, changedHooks, input.cancelTurn);
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
 * Evaluates the session's dynamic values before a model call: each `select` reads the view and
 * the conversation the call reads, and `record` and `render` run for a selection that changed, a
 * record another deployment made, or one whose render didn't match. Throws
 * {@link ReactionFailedError} for the first value that fails; nothing is recorded for it.
 */
export async function evaluateValues(
  ctx: ContextContainer,
  input: {
    readonly abortSignal?: AbortSignal;
    readonly conversation: readonly ModelMessage[];
  },
): Promise<void> {
  const { reactions, effects } = await bundleReactions(ctx);
  const values = reactions.filter((reaction) => reaction.timing !== "commit");
  if (values.length === 0) return;
  const state = readReactionsState(ctx);
  const line = state.latest["*"] ?? 0;
  const revision = state.revision;
  const selectContext = selectContextOf(ctx);
  const changedKinds = new Set<ReactionKind>();
  for (const reaction of values) {
    const started = Date.now();
    let selection: JsonValue;
    try {
      selection = selectionOf(
        reaction,
        reactionView(ctx, reaction.kind, input.conversation),
        selectContext,
      );
    } catch (error) {
      throw failed(reaction, error);
    }
    const digest = digestOf(selection);
    const slot = readSlot(ctx, reaction.id);
    const trigger =
      slot === undefined
        ? "first"
        : slot.digest !== digest
          ? "selection"
          : slot.invalid === true
            ? "mismatch"
            : slot.revision !== revision
              ? "deployment"
              : undefined;
    if (trigger === undefined) continue;
    const occurrence =
      slot !== undefined && slot.digest === digest
        ? (slot.occurrence ?? 1)
        : (slot?.occurrence ?? 0) + 1;
    let changed: boolean;
    try {
      ({ changed } = await evaluate(ctx, reaction, {
        abortSignal: input.abortSignal,
        conversation: input.conversation,
        digest,
        line,
        occurrence,
        revision,
        selection,
        written: [],
      }));
    } catch (error) {
      throw failed(reaction, error);
    }
    if (changed) changedKinds.add(reaction.kind);
    log.debug("Evaluated a dynamic value", {
      changed,
      durationMs: Date.now() - started,
      occurrence,
      reaction: reaction.label,
      trigger,
    });
  }
  for (const kind of changedKinds) await effects[kind]?.(ctx);
}

function failed(reaction: Reaction, error: unknown): ReactionFailedError {
  log.error(`Dynamic value "${reaction.label}" failed; the turn fails.`, {
    error: toErrorMessage(error),
    kind: reaction.kind,
  });
  return new ReactionFailedError(reaction.label, error);
}

/**
 * Stops the running turn for the first cancel intent that targets it, and drops cancels and
 * failures whose turn has ended. One the commit can't act on waits for a commit that can, while
 * its turn still runs.
 */
function actOnCancels(
  ctx: ContextContainer,
  reactions: readonly Reaction[],
  changedHooks: ReadonlySet<string>,
  cancelTurn: RunReactionsInput["cancelTurn"],
): void {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  takeIntents(
    ctx,
    (intent) => (intent.type === "cancel" || intent.type === "fail") && intent.turnId !== turnId,
  );
  const pending = (readReactionsState(ctx).intents ?? []).filter(
    (intent) => intent.type === "cancel",
  );
  const [first] = pending;
  if (first === undefined) return;
  const hook = reactions.find(({ id }) => id === first.reactionId)?.label ?? first.reactionId;
  if (cancelTurn === undefined) {
    if (pending.some(({ reactionId }) => changedHooks.has(reactionId))) {
      log.warn("A hook's cancel() waits: this commit cannot stop the running turn", { hook });
    }
    return;
  }
  takeIntents(ctx, (intent) => intent.type === "cancel");
  cancelTurn({ hook, ...(first.reason !== undefined && { reason: first.reason }) });
}

function startsCompaction(written: readonly WrittenEvent[]): boolean {
  return written.some(
    ({ event }) =>
      event.type === "context.started" &&
      (event.data as { readonly kind?: string }).kind === "compaction",
  );
}

/**
 * Renders the code of every slot that carries some, for a step in a process that didn't render it:
 * `render` runs with the JSON the slot recorded, and `record` doesn't run. What the code offers
 * must match what the session was offered; a slot whose render doesn't, or another deployment
 * recorded, renders nothing here, and the next model call evaluates it again.
 */
export async function restoreReactions(
  ctx: ContextContainer,
  input: { readonly abortSignal?: AbortSignal; readonly revision?: string } = {},
): Promise<void> {
  if (input.revision !== undefined) {
    writeReactionsState(ctx, { ...readReactionsState(ctx), revision: input.revision });
  }
  // Outside production, EVE_REACTIONS_COLD=1 makes every step build its code as a fresh process
  // would, which tests recovery without a restart. A deployment never reads it.
  if (process.env.NODE_ENV !== "production" && process.env.EVE_REACTIONS_COLD === "1") {
    const sessionId = ctx.get(SessionIdKey);
    if (sessionId !== undefined) forgetSessionLive(sessionId);
  }
  const { reactions } = await bundleReactions(ctx);
  dropRemovedSlots(ctx, reactions);
  const revision = readReactionsState(ctx).revision;
  for (const reaction of reactions) {
    const slot = readSlot(ctx, reaction.id);
    if (reaction.render === undefined || slot?.input === undefined || slot.invalid === true) {
      continue;
    }
    // The new deployment must not render another's data with its own render.
    if (slot.revision !== revision) continue;
    if (readLive(ctx, reaction.id, slot) !== undefined) continue;
    const rctx = recordContextOf(ctx, {
      abortSignal: input.abortSignal,
      digest: slot.digest,
      occurrence: slot.occurrence ?? 1,
      written: [],
    });
    log.debug("Rendering a reaction's code again from what its slot recorded", {
      reaction: reaction.label,
    });
    try {
      const contribution = await reaction.contribute(await reaction.render(slot.input, rctx), rctx);
      const offered = parseJsonValue(contribution.value ?? null);
      if (canonicalJson(offered) !== canonicalJson(slot.value)) {
        throw new Error(
          `"${reaction.label}" rendered something other than what this session was offered, so its render isn't deterministic. The next model call evaluates it again.`,
        );
      }
      if (contribution.live !== undefined) writeLive(ctx, reaction.id, slot, contribution.live);
    } catch (error) {
      log.warn(`Reaction "${reaction.label}" didn't render from its record.`, {
        error: toErrorMessage(error),
      });
      writeSlot(ctx, reaction.id, { ...slot, invalid: true });
      clearLive(ctx, reaction.id);
    }
  }
}

/**
 * Drops the slots of reactions the bundle no longer has, such as a dynamic instruction file a new
 * deployment deleted, so readers that list a kind's slots stop offering what they held. The
 * step's effects then apply what remains.
 */
function dropRemovedSlots(ctx: ContextContainer, reactions: readonly Reaction[]): void {
  const state = readReactionsState(ctx);
  const ids = new Set(reactions.map(({ id }) => id));
  const removed = Object.keys(state.slots).filter((id) => !ids.has(id));
  if (removed.length === 0) return;
  const slots = { ...state.slots };
  for (const id of removed) {
    delete slots[id];
    clearLive(ctx, id);
  }
  writeReactionsState(ctx, { ...state, slots });
}

/** Applies every kind's slots to the step's process-local state, such as its connection registry. */
export async function applyReactionEffects(ctx: ContextContainer): Promise<void> {
  const { effects } = await bundleReactions(ctx);
  for (const effect of Object.values(effects)) await effect(ctx);
}

function writeSlot(ctx: ContextContainer, id: string, slot: Slot | undefined): void {
  const state = readReactionsState(ctx);
  const slots = { ...state.slots };
  if (slot === undefined) delete slots[id];
  else slots[id] = slot;
  writeReactionsState(ctx, { ...state, slots });
}

function failedSlot(
  previous: Slot | undefined,
  digest: string,
  line: number,
  error: unknown,
): Slot {
  return {
    digest,
    error: toErrorMessage(error),
    since: previous?.value === null ? previous.since : line,
    value: null,
    ...(previous?.occurrence !== undefined && { occurrence: previous.occurrence }),
  };
}

/** The largest record eve keeps for a reaction, in UTF-8 bytes of JSON. */
const RECORD_CAP = 1024 * 1024;

/**
 * Evaluates one occurrence into its slot: `record` fetches, eve keeps its JSON when the value
 * carries code, and `render` makes the value. Returns whether the slot's contribution changed.
 * Throws without writing the slot.
 */
async function evaluate(
  ctx: ContextContainer,
  reaction: Reaction,
  run: {
    readonly abortSignal: AbortSignal | undefined;
    readonly conversation: readonly ModelMessage[] | undefined;
    readonly digest: string;
    readonly line: number;
    readonly occurrence: number;
    readonly revision?: string;
    readonly selection: JsonValue;
    readonly written: readonly WrittenEvent[];
  },
): Promise<{ readonly changed: boolean }> {
  const previous = readSlot(ctx, reaction.id);
  const rctx = recordContextOf(ctx, run);
  const recorded =
    reaction.record === undefined ? run.selection : await reaction.record(run.selection, rctx);
  let result = recorded;
  let input: JsonValue | undefined;
  if (reaction.render !== undefined) {
    input = recordable(reaction, recorded);
    result = await reaction.render(input, rctx);
  }
  const contribution = await reaction.contribute(result, rctx);
  const value = parseJsonValue(contribution.value ?? null);
  if (input === undefined) assertStorable(reaction, value);
  const live = contribution.live;
  // In development, render twice: a render that isn't deterministic shows up now, rather than
  // after a cold start in production.
  if (live !== undefined && input !== undefined && isEveDevEnvironment()) {
    const again = await reaction.contribute(await reaction.render!(input, rctx), rctx);
    if (canonicalJson(parseJsonValue(again.value ?? null)) !== canonicalJson(value)) {
      throw new Error(
        `"${reaction.label}" rendered differently from the same record. render must be deterministic: a fresh process renders again from what was recorded. Move randomness, time, and I/O into record.`,
      );
    }
  }
  const unchanged =
    previous !== undefined && canonicalJson(previous.value) === canonicalJson(value);
  const slot: Slot = {
    digest: run.digest,
    occurrence: run.occurrence,
    since: unchanged ? previous.since : run.line,
    value,
    ...(live !== undefined && input !== undefined && { input }),
    ...(run.revision !== undefined && { revision: run.revision }),
  };
  writeSlot(ctx, reaction.id, slot);
  if (live === undefined) clearLive(ctx, reaction.id);
  else writeLive(ctx, reaction.id, slot, live);
  // Live code can change while its JSON doesn't, such as a connection's headers under the same
  // name, so a value rendered again applies its kind's effects again.
  return { changed: !unchanged || live !== undefined };
}

/** What `render` renders from, which eve keeps: it must be JSON. */
function recordable(reaction: Reaction, recorded: unknown): JsonValue {
  let input: JsonValue;
  try {
    input = parseJsonValue(recorded ?? null);
  } catch {
    throw new Error(
      `The record of "${reaction.label}" must return JSON: eve keeps it, and render makes the value from it. Return the data, and create tools, clients, or models in render.`,
    );
  }
  assertStorable(reaction, input);
  return input;
}

function assertStorable(reaction: Reaction, value: JsonValue): void {
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > RECORD_CAP) {
    throw new Error(
      `"${reaction.label}" recorded ${Math.ceil(size / 1024)} KB of JSON; a record is at most 1 MB, and every step of the session carries it. Record an ID, and fetch the rest where it's used.`,
    );
  }
}

/** The largest selection eve digests, in UTF-8 bytes of JSON. */
const SELECTION_CAP = 64 * 1024;

function selectionOf(reaction: Reaction, view: ReactionView, ctx: SelectContext): JsonValue {
  if (reaction.select === undefined) return null;
  const selected = reaction.select(view, ctx);
  let selection: JsonValue;
  try {
    selection = parseJsonValue(selected ?? null);
  } catch {
    throw new Error(`The select of "${reaction.label}" must return JSON.`);
  }
  const size = Buffer.byteLength(JSON.stringify(selection));
  if (size > SELECTION_CAP) {
    throw new Error(
      `The select of "${reaction.label}" returned ${Math.ceil(size / 1024)} KB of JSON; a selection is at most 64 KB. Select an ID that record can look up instead.`,
    );
  }
  return selection;
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

/** Kinds that run before the model, so can't read the model it chooses. */
const BEFORE_MODEL = new Set<ReactionKind>(
  REACTION_ORDER.slice(0, REACTION_ORDER.indexOf("model") + 1),
);

/**
 * The view a reaction of `kind` selects from. It holds only what earlier kinds have contributed:
 * a kind that runs before the model, or the model itself, would otherwise read the previous
 * model.
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
      turn: { enumerable: true, value: latestTurn(currentView(ctx)) },
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
    ...(conversation !== undefined && { conversation }),
    session: {
      auth: { current: ctx.get(AuthKey) ?? null, initiator: ctx.get(InitiatorAuthKey) ?? null },
      id: ctx.get(SessionIdKey) ?? "",
      predecessor: ctx.get(SessionPredecessorKey),
      schedule: readSessionSchedule(ctx),
    },
  };
}

function recordContextOf(
  ctx: ContextContainer,
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly conversation?: readonly ModelMessage[];
    readonly digest: string;
    readonly occurrence: number;
    readonly written: readonly WrittenEvent[];
  },
): InternalRecordContext {
  return {
    ...selectContextOf(ctx),
    abortSignal: input.abortSignal ?? neverAborted,
    ctx,
    digest: input.digest,
    facts: input.written.map(({ event }) => event),
    history: input.conversation,
    occurrence: input.occurrence,
    written: input.written,
  };
}

export type { BundleReactions };
