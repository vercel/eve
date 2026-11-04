import type { ModelMessage } from "ai";

import { sandboxOf } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { HistoryStateKey, SessionIdKey } from "#context/keys.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { announcementDigest } from "#harness/announcements.js";
import { withUsageInEffect } from "#harness/usage-sink.js";
import { sessionFrameOf } from "#definitions/frame.js";
import { reportEffectFailure } from "#definitions/intents.js";
import { openMemos } from "#definitions/memos.js";
import {
  clearLive,
  digestOf,
  discardedByDeployment,
  forgetSessionLive,
  keepMemos,
  mergeMemos,
  readLive,
  readDefinitionsState,
  readSlot,
  sessionIdOf,
  type DefinitionsState,
  type Slot,
  writeLive,
  writeDefinitionsState,
} from "#definitions/state.js";
import { collectEffects, draftOf } from "./combine.js";
import {
  type CommitInput,
  type Contribution,
  type Definition,
  type DefinitionContext,
  type Evaluate,
  type InternalContext,
  type Kept,
  requireHistory,
} from "./definition.js";
import { chooseModel, effectiveModelId } from "./model.js";
import { sessionDefinitions } from "./agent.js";
import { bindOpeningCancel, settleHookCommands } from "./hooks.js";
import { staticUserInstructions } from "./instructions.js";
import { readEnv } from "#platform/env.js";

// The kernel asks definitions what they add, on two schedules. Before each model call it evaluates
// what they keep, with the conversation that call reads; everything else reads what that left,
// and a process that lacks a kept value's code evaluates it again with its memos. After every
// commit it runs the effects definitions name, so they notice a change when it happens. An
// evaluation that fails fails the turn, and keeps nothing but the memos that succeeded.

const log = createLogger("definitions");
const neverAborted = new AbortController().signal;

/** Where eve asks the definitions. */
export type Where = Pick<DefinitionContext, "step" | "call" | "commit"> &
  Partial<Pick<DefinitionContext, "history" | "signal">>;

/**
 * What each definition adds, where eve asks. `evaluate` evaluates what they keep, each at most once;
 * `read` reads what the latest evaluation kept, evaluating again only what this process lacks the
 * code of.
 */
export function contributionsOf(
  definitions: readonly Definition[],
  container: ContextReader,
  where: Where,
  mode: "evaluate" | "read" = "read",
): Contribution[] {
  const kept = new Map<string, Promise<Kept | undefined>>();
  const signal = where.signal ?? neverAborted;
  return definitions.map((definition) =>
    definition.contribute({
      ...where,
      container,
      history: where.history,
      keep: (evaluate, options) => {
        let value = kept.get(definition.id);
        if (value === undefined) {
          value = keepOne(container, definition, evaluate, {
            choosesModel: options?.choosesModel === true,
            history: where.history,
            mode: mode === "read" ? "restore" : "evaluate",
            signal,
          });
          kept.set(definition.id, value);
        }
        return value;
      },
      signal,
    }),
  );
}

async function keepOne(
  container: ContextReader,
  definition: Definition,
  fn: Evaluate,
  run: Run,
): Promise<Kept | undefined> {
  if (container.get(SessionIdKey) === undefined) return undefined;
  const ctx = container as ContextContainer;
  if (run.mode === "restore") {
    const slot = readSlot(ctx, definition.id);
    if (slot === undefined) return undefined;
    if (slot.live !== true) return { value: slot.value };
    const live = readLive(ctx, definition.id, slot);
    if (live !== undefined) return { live: live.live, value: slot.value };
  }
  const started = Date.now();
  let result: Awaited<ReturnType<typeof evaluate>>;
  try {
    result = await evaluate(ctx, definition, fn, run);
  } catch (error) {
    if (run.mode === "evaluate") {
      log.error(`Dynamic value "${definition.label}" failed; the turn fails.`, {
        error: toErrorMessage(error),
      });
      throw new DefinitionFailedError(definition.label, error);
    }
    // The next model call evaluates it again, and fails the turn if it still fails.
    log.warn(`Dynamic value "${definition.label}" didn't evaluate for this step.`, {
      error: toErrorMessage(error),
    });
    return { value: readSlot(ctx, definition.id)!.value };
  }
  log.debug("Evaluated a dynamic value", {
    changed: result.changed,
    definition: definition.label,
    durationMs: Date.now() - started,
  });
  if (result.changed) await definition.install?.(ctx);
  return result.kept;
}

export interface RunEffectsInput {
  readonly written: readonly WrittenEvent[];
  readonly abortSignal?: AbortSignal;
  /** The conversation as of this commit, or `undefined` in a step that doesn't hold it. */
  readonly conversation?: readonly ModelMessage[];
  /** Stops the running turn; absent when this commit can't stop one. */
  readonly cancelTurn?: CommitInput["cancelBeforeTurn"];
  readonly cancelBeforeTurn?: CommitInput["cancelBeforeTurn"];
}

/** Runs after every commit: the effects every definition names for it, in definition order. */
export async function runEffects(ctx: ContextContainer, input: RunEffectsInput): Promise<void> {
  const definitions = await sessionDefinitions(ctx);
  writeDefinitionsState(
    ctx,
    bindOpeningCancel(withLatest(readDefinitionsState(ctx), input.written), input.written),
  );
  if (input.written.length === 0) return;
  let cancelBeforeTurn: (() => void) | undefined;
  const beforeTurn = input.cancelBeforeTurn;
  const commit: CommitInput = {
    ...(beforeTurn !== undefined && {
      cancelBeforeTurn: (cancel) => {
        cancelBeforeTurn ??= () => beforeTurn(cancel);
      },
    }),
    written: input.written,
  };
  const contributions = contributionsOf(definitions, ctx, {
    commit,
    history: input.conversation,
    signal: input.abortSignal,
  });
  for (const [index, contribution] of contributions.entries()) {
    const definition = definitions[index]!;
    for (const effect of await collectEffects([contribution])) {
      try {
        await withUsageInEffect(() => effect.run());
      } catch (error) {
        if (effect.blocking !== true) {
          reportEffectFailure(ctx, { id: effect.id, label: definition.label }, error);
        } else if (!blockingFailures.has(ctx)) blockingFailures.set(ctx, error);
      }
    }
  }
  settleHookCommands(ctx, definitions, input);
  cancelBeforeTurn?.();
}

/** What a blocking effect threw, for the operation its commit started. */
const blockingFailures = new WeakMap<object, unknown>();

/**
 * Takes what a blocking effect threw after the commit that started an operation: the operation
 * then fails before it goes further.
 */
export function takeBlockingFailure(ctx: object): unknown {
  if (!blockingFailures.has(ctx)) return undefined;
  const error = blockingFailures.get(ctx);
  blockingFailures.delete(ctx);
  return error ?? new Error("A blocking effect failed.");
}

/** A dynamic value failed to evaluate before a model call: the turn fails. */
export class DefinitionFailedError extends Error {
  override readonly name = "DefinitionFailedError";
  readonly definition: string;

  constructor(definition: string, error: unknown) {
    super(toErrorMessage(error), { cause: error });
    this.definition = definition;
  }
}

/**
 * Prepares a step: on a move to another deployment, discards memos; drops what definitions the
 * bundle no longer has kept; and reads the call as it stands, which evaluates again each kept
 * value whose code this process doesn't hold, so a step that runs a tool call or reaches a
 * connection before its model call has them. Its memos return what they kept, so this asks
 * nothing of the outside world again.
 */
export async function restoreDefinitions(
  ctx: ContextContainer,
  input: {
    readonly abortSignal?: AbortSignal;
    readonly conversation?: readonly ModelMessage[];
    readonly revision?: string;
  } = {},
): Promise<void> {
  announceHeldInstructions(ctx, input.conversation);
  const before = readDefinitionsState(ctx);
  if (input.revision !== undefined && input.revision !== before.revision) {
    const moved = before.revision !== undefined && before.memos !== undefined;
    if (moved) log.info("The session moved to another deployment; its memos run again.");
    const { memos, ...rest } = before;
    writeDefinitionsState(ctx, {
      ...(moved ? { ...rest, discarded: Object.keys(memos ?? {}) } : before),
      revision: input.revision,
    });
  }
  // Outside production, EVE_DEFINITIONS_COLD=1 makes every step build its code as a fresh process
  // would, which tests recovery without a restart. A deployment never reads it.
  if (process.env.NODE_ENV !== "production" && readEnv("EVE_DEFINITIONS_COLD") === "1") {
    const sessionId = ctx.get(SessionIdKey);
    if (sessionId !== undefined) forgetSessionLive(sessionId);
  }
  const definitions = await sessionDefinitions(ctx);
  dropRemovedSlots(ctx, definitions);
  const contributions = contributionsOf(definitions, ctx, {
    history: input.conversation,
    signal: input.abortSignal,
  });
  await chooseModel(contributions, ctx);
  const draft = draftOf(contributions);
  await draft.tools();
  await draft.system();
}

/**
 * Sessions from before static user instructions were announced started their history with them.
 * One the history still holds counts as announced, so the same content doesn't join again. It
 * needs the deployment's files, so it can't move with the rest into the checkpoint upgrade.
 */
function announceHeldInstructions(
  ctx: ContextContainer,
  conversation: readonly ModelMessage[] | undefined,
): void {
  const history = ctx.get(HistoryStateKey) ?? {};
  const unannounced = staticUserInstructions(ctx).filter(
    ({ key }) => history.announcements?.[key] === undefined,
  );
  if (unannounced.length === 0) return;
  const said = new Set(
    (conversation ?? []).flatMap((message) =>
      message.role === "user" &&
      (message as { readonly kind?: string }).kind === "context.instruction" &&
      typeof message.content === "string"
        ? [message.content]
        : [],
    ),
  );
  const held = unannounced.filter(({ content }) => said.has(content));
  if (held.length === 0) return;
  ctx.set(HistoryStateKey, {
    ...history,
    announcements: {
      ...Object.fromEntries(held.map(({ content, key }) => [key, digestOf(content)])),
      ...history.announcements,
    },
    messages: {
      ...Object.fromEntries(
        held.map(({ content, key }) => [key, announcementDigest("context.instruction", content)]),
      ),
      ...history.messages,
    },
  });
}

/**
 * Drops what definitions the bundle no longer has kept, such as a dynamic instruction file a new
 * deployment deleted, so readers of the session's kept values stop offering what they held.
 */
function dropRemovedSlots(ctx: ContextContainer, definitions: readonly Definition[]): void {
  const state = readDefinitionsState(ctx);
  const ids = new Set(definitions.map(({ id }) => id));
  const removed = Object.keys(state.slots).filter((id) => !ids.has(id));
  const removedMemos = Object.keys(state.memos ?? {}).filter(
    (scope) => !ids.has(scope.split("#")[0]!),
  );
  if (removed.length === 0 && removedMemos.length === 0) return;
  const slots = { ...state.slots };
  for (const id of removed) {
    delete slots[id];
    clearLive(ctx, id);
  }
  const memos = { ...state.memos };
  for (const scope of removedMemos) delete memos[scope];
  writeDefinitionsState(ctx, { ...state, memos, slots });
}

/** Applies what definitions keep to the step's process-local state, such as its connection registry. */
export async function installDefinitions(ctx: ContextContainer): Promise<void> {
  const installs = new Set((await sessionDefinitions(ctx)).map(({ install }) => install));
  for (const install of installs) await install?.(ctx);
}

function writeSlot(ctx: ContextContainer, id: string, slot: Slot): void {
  const state = readDefinitionsState(ctx);
  writeDefinitionsState(ctx, { ...state, slots: { ...state.slots, [id]: slot } });
}

interface Run {
  readonly signal: AbortSignal;
  readonly history?: readonly ModelMessage[];
  readonly mode: "evaluate" | "restore";
  readonly choosesModel: boolean;
}

/**
 * Evaluates what one definition keeps, and keeps it. Returns whether it changed, or carries code,
 * which the evaluation built anew. Throws without changing what was kept; the memos that ran are
 * kept.
 */
async function evaluate(
  ctx: ContextContainer,
  definition: Definition,
  fn: Evaluate,
  run: Run,
): Promise<{ readonly changed: boolean; readonly kept: Kept }> {
  const previous = readSlot(ctx, definition.id);
  const call = async (memo: InternalContext["memo"]) =>
    (await fn(internalContext(ctx, definition, { ...run, memo }), previous?.value)) ?? {
      value: null,
    };
  const { result, used } = await withMemos(
    ctx,
    { abortSignal: run.signal, label: definition.label, scope: definition.id },
    call,
  );
  const value = parseJsonValue(result.value ?? null);
  const digest = digestOf(value);
  // In development, evaluate again with the memos fixed: a value that changes anyway depends on
  // something outside its memos, such as randomness or the time, and shows up now rather than
  // after a cold start in production.
  if (isEveDevEnvironment() && run.mode === "evaluate") {
    const memos = openMemos({
      abortSignal: run.signal,
      kept: used,
      label: definition.label,
      restoring: "a second evaluation used a memo key the first didn't",
      scope: definition.id,
      sessionId: sessionIdOf(ctx),
    });
    await call(memos.memo).then(
      (again) => {
        if (digestOf(parseJsonValue(again.value ?? null)) === digest) return;
        log.warn(
          `Dynamic value "${definition.label}" returned something different when evaluated again with the same memos. Code outside a memo, such as Math.random() or Date.now() in a name or description, makes eve rebuild it before every model call; move it into a memo, or use ctx.now.`,
        );
      },
      (error: unknown) =>
        log.warn(
          `Dynamic value "${definition.label}" failed when evaluated again with the same memos.`,
          { error: toErrorMessage(error) },
        ),
    );
    memos.close();
  }
  // Nothing kept, and nothing before: the session holds no slot for it.
  if (value === null && previous === undefined && result.live === undefined) {
    return { changed: false, kept: { value } };
  }
  const unchanged = previous?.digest === digest;
  if (!unchanged && previous !== undefined && run.mode === "restore") {
    log.warn(
      `Dynamic value "${definition.label}" offers something other than what the session was offered after a restart: code outside its memos answered differently. eve offers the new value from the next model call.`,
    );
  }
  const line = readDefinitionsState(ctx).latest["*"] ?? 0;
  const slot: Slot = {
    digest,
    since: unchanged ? previous.since : line,
    value,
    ...(result.live !== undefined && { live: true as const }),
  };
  writeSlot(ctx, definition.id, slot);
  if (result.live === undefined) clearLive(ctx, definition.id);
  else writeLive(ctx, definition.id, slot, result.live);
  return {
    changed: !unchanged || result.live !== undefined,
    kept: { value, ...(result.live !== undefined && { live: result.live }) },
  };
}

/**
 * Runs `fn` with `scope`'s memos. When it succeeds, the scope keeps what this run used; when it
 * fails, what ran joins what the scope had.
 */
async function withMemos<T>(
  ctx: ContextContainer,
  input: { readonly scope: string; readonly label: string; readonly abortSignal?: AbortSignal },
  fn: (memo: InternalContext["memo"]) => Promise<T>,
): Promise<{ readonly result: T; readonly used: Readonly<Record<string, JsonValue>> }> {
  const memos = openMemos({
    abortSignal: input.abortSignal ?? neverAborted,
    afterDeployment: discardedByDeployment(ctx, input.scope),
    kept: readDefinitionsState(ctx).memos?.[input.scope],
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

function internalContext(
  ctx: ContextContainer,
  definition: Definition,
  run: Run & { readonly memo: InternalContext["memo"] },
): InternalContext {
  const frame = sessionFrameOf(ctx);
  const { history } = run;
  return Object.defineProperties(
    {
      ...frame,
      abortSignal: run.signal,
      ctx,
      getSandbox: run.choosesModel
        ? () => {
            throw new Error(
              `"${definition.label}" called ctx.getSandbox() while choosing the model. Choose the model from the session, and read the sandbox in the definitions that use it.`,
            );
          }
        : run.mode === "restore"
          ? () => {
              // Restoring runs before the step opens its sandbox. A memo that reads it under a
              // new key would change the value anyway, so the next model call's evaluation does.
              throw new Error(
                `"${definition.label}" called ctx.getSandbox() while eve rebuilt it in a fresh process, before the step opened its sandbox. eve evaluates it again, with the sandbox, before the next model call.`,
              );
            }
          : sandboxOf(ctx),
      history,
      memo: run.memo,
      messages: async () => requireHistory(history, definition.label),
    },
    {
      model: {
        enumerable: true,
        get() {
          if (run.choosesModel) {
            throw new Error(
              `"${definition.label}" read ctx.model while choosing the model. The model field's function runs before the model is chosen.`,
            );
          }
          const id = effectiveModelId(ctx);
          if (id === undefined) {
            throw new Error(`"${definition.label}" read ctx.model before the session chose one.`);
          }
          return { id };
        },
      },
    },
  ) as InternalContext;
}

function withLatest(state: DefinitionsState, written: readonly WrittenEvent[]): DefinitionsState {
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
