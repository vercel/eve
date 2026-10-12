import type { ModelMessage } from "ai";

import type { SessionAuth, SessionPredecessor } from "#context/keys.js";
import type { SessionSchedule } from "#context/session-schedule.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { ConversationContext } from "#shared/conversation-context.js";

/**
 * The session's latest turn, running or not. Select its `id` to resolve once per turn: it stays
 * the same through the turn's tool calls, pauses, and steering, and until the next turn starts.
 */
export interface ReactionTurn {
  readonly id: string;
  readonly status: "running" | "paused" | "settled";
  /**
   * What started the turn: the parts of the messages it opened with. Messages that steer it
   * later don't change them.
   */
  readonly input: readonly UserPart[];
}

/**
 * What a reaction selects from: the session's tables, the position of the latest event of each
 * type, the latest turn, the effective model, and the conversation.
 *
 * `messages` is the conversation as the model sees it. Dynamic values select before each model
 * call, with the conversation it reads. A hook's `select` that reads it runs only where the step
 * holds it: steps that settle background work between turns don't.
 */
export interface ReactionView extends SessionView {
  /** The line position of the latest event of each type, and `"*"` for the latest fact. */
  readonly latest: Readonly<Record<string, number | undefined>>;
  /** The session's latest turn, or `null` before its first. */
  readonly turn: ReactionTurn | null;
  /** The model the session uses now, or `null` before one is chosen. */
  readonly model: { readonly id: string } | null;
  readonly messages: readonly ModelMessage[];
}

/** The session's identity, auth, and channel, for `select` and `record`. */
export interface SelectContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly schedule?: SessionSchedule;
    /**
     * Present when eve started this session in place of a stranded session,
     * one that another eve version built. It names the earlier session, whose recorded stream
     * `sessions.attach(predecessor.sessionId)` from `eve/server` reads.
     */
    readonly predecessor?: SessionPredecessor;
  };
  readonly channel: {
    /** Channel type that produced the request (e.g. `"slack"`, `"http"`), when known. */
    readonly kind?: string;
    /** Channel-owned resume handle for the conversation, when the channel supplies one. */
    readonly continuationToken?: string;
    /** Free-form channel-specific metadata attached to the request. */
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  /** Classification and execution context for the active conversation, when known. */
  readonly conversation?: ConversationContext;
}

/**
 * What `record` receives besides its selection: the session's identity and channel, an
 * `abortSignal`, and the conversation. eve calls `record` once for each new selection and keeps
 * what it returns, so only `select` is watched: a change to anything `record` reads here doesn't
 * record again. Select what should.
 */
export interface RecordContext extends SelectContext {
  readonly abortSignal: AbortSignal;
  /**
   * The conversation as the model sees it. Before a model call, it's what the call reads. Steps
   * that settle background work between turns don't hold it, and reading it there throws.
   */
  messages(): Promise<readonly ModelMessage[]>;
}

/** Reads what a reaction depends on. Synchronous and deterministic; returns JSON. */
export type ReactionSelect<TSelected, TView = ReactionView> = (
  view: TView,
  ctx: SelectContext,
) => TSelected;

/**
 * Fetches what a value is made of, given what `select` read, or acts once on it. It runs once for
 * each new selection, may await, and eve keeps what it returns.
 */
export type ReactionRecord<TSelected, TResult> = (
  selected: TSelected,
  ctx: RecordContext,
) => TResult | Promise<TResult>;

/**
 * Renders what the session should have, such as tools, instructions, a model, or a hook's
 * intents, from what `select` read, or from what `record` kept. Synchronous, so it can't do I/O.
 * A process that has never seen the session renders again from what was kept, and never records.
 */
export type ReactionRender<TInput, TResult> = (input: TInput) => TResult;

/** Resolves once per session: `select: once`. */
export const once = (): null => null;

/** Resolves once per turn: `select: perTurn`. */
export const perTurn = (view: { readonly turn: { readonly id: string } | null }): string | null =>
  view.turn?.id ?? null;

/**
 * Resolves once per model call: `select: perStep`. Each ordinary model call of a turn is a new
 * one, including the call after a tool batch or a resumed approval; compaction's call isn't.
 */
export const perStep = (view: {
  readonly latest: Readonly<Record<string, number | undefined>>;
}): number | null => view.latest["model.requested"] ?? null;

/** Marker discriminator for a `defineDynamic()` or `defineHook()` export. */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/** A `defineDynamic()` export, which the compiler detects by its `kind`. */
export interface DynamicSentinel<TResult = unknown, TSelected = unknown> {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly select: ReactionSelect<TSelected>;
  readonly record?: ReactionRecord<TSelected, unknown>;
  readonly render?: ReactionRender<never, TResult>;
}

/** The usual form: `render` makes the value from the selection. */
export interface DynamicRenderDefinition<TSelected, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly render: ReactionRender<TSelected, TResult>;
  readonly record?: never;
}

/** With I/O: `record` fetches JSON, which eve keeps, and `render` makes the value from it. */
export interface DynamicRecordRenderDefinition<TSelected, TData, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly record: ReactionRecord<TSelected, TData>;
  readonly render: ReactionRender<TData, TResult>;
}

/** When what `record` fetches is already the value. */
export interface DynamicRecordDefinition<TSelected, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly record: ReactionRecord<TSelected, TResult>;
  readonly render?: never;
}

/** `defineDynamic()` typed for the folder it's authored in. */
export interface DefineDynamic<TResult> {
  <TSelected, TData, TStatic extends object = object>(
    definition: DynamicRecordRenderDefinition<TSelected, TData, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
  <TSelected, TStatic extends object = object>(
    definition: DynamicRenderDefinition<TSelected, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
  <TSelected, TStatic extends object = object>(
    definition: DynamicRecordDefinition<TSelected, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
}

/**
 * `defineDynamic()` for folders whose values carry code, tools and connections: they're always
 * rendered, since what `record` keeps must be JSON.
 */
export interface DefineDynamicRendered<TResult> {
  <TSelected, TData, TStatic extends object = object>(
    definition: DynamicRecordRenderDefinition<TSelected, TData, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
  <TSelected, TStatic extends object = object>(
    definition: DynamicRenderDefinition<TSelected, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
}

/**
 * The one definition every authored reaction compiles from: `select` with `record`, `render`, or
 * both; a hook's `select` with `run`; or a hook's map of `events` handlers. `defineDynamic()` and
 * `defineHook()` narrow it.
 */
export type ReactionDefinition =
  | {
      readonly select: (...args: never[]) => unknown;
      readonly record?: (...args: never[]) => unknown;
      readonly render?: (...args: never[]) => unknown;
      readonly run?: never;
      readonly events?: never;
    }
  | {
      readonly select: (...args: never[]) => unknown;
      readonly run: (...args: never[]) => unknown;
      readonly record?: never;
      readonly render?: never;
      readonly events?: never;
    }
  | {
      readonly events: Readonly<Record<string, unknown>>;
      readonly select?: never;
      readonly record?: never;
      readonly render?: never;
      readonly run?: never;
    };

/** Validates a reaction's form and marks it for the compiler. Not public: use its narrowings. */
export function defineReaction<T extends ReactionDefinition>(
  definition: T,
  name: string,
  options: ReactionFormOptions = {},
): T & { readonly kind: typeof DYNAMIC_SENTINEL_KIND } {
  assertReactionForm(definition, `${name}()`, options);
  const sentinel = { ...definition, kind: DYNAMIC_SENTINEL_KIND };
  stampDefinitionKey(sentinel, "dynamic");
  return sentinel;
}

/** A hook's form: `select` with `run`, or a map of `events` handlers. */
export const HOOK_FORM: ReactionFormOptions = { hook: true };

export interface ReactionFormOptions {
  /** A hook: `select` with `run`, or a map of `events` handlers. */
  readonly hook?: boolean;
  /** Whether `render` is required: for tools and connections, whose values are code. */
  readonly render?: "required";
}

/**
 * Throws unless `value` takes one form: a value's `select` with `record`, `render`, or both, or a
 * hook's `select` with `run`, or its `events` object. The definers, the compiler, and the runtime
 * loader all use it, so every source agrees.
 */
export function assertReactionForm(
  value: unknown,
  subject: string,
  options: ReactionFormOptions = {},
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${subject} takes an object.`);
  }
  const { events, record, render, run, select } = value as Record<string, unknown>;
  if (options.hook === true) {
    if (record !== undefined || render !== undefined) {
      throw new Error(
        `${subject} takes select with run, or events: a hook acts rather than holds a value, so it has nothing to render. Do the work in run, and return cancel() or compact() from it.`,
      );
    }
    if (events !== undefined) {
      if (select !== undefined || run !== undefined) {
        throw new Error(`${subject} takes either events, or select with run, not both.`);
      }
      if (typeof events !== "object" || events === null) {
        throw new Error(`${subject} events must be an object of handlers.`);
      }
      return;
    }
    if (typeof run !== "function") {
      throw new Error(`${subject} requires events, or select with a run function.`);
    }
    if (typeof select !== "function") {
      throw new Error(`${subject} requires a select function beside run.`);
    }
    return;
  }
  if (events !== undefined) {
    throw new Error(`${subject} takes select with record or render, not events.`);
  }
  if (run !== undefined) {
    throw new Error(
      `${subject} takes select with record or render. run is a hook's: a value renders what the session should have.`,
    );
  }
  if (record !== undefined && typeof record !== "function") {
    throw new Error(`${subject} record must be a function.`);
  }
  if (render !== undefined && typeof render !== "function") {
    throw new Error(`${subject} render must be a function.`);
  }
  if (options.render === "required" && render === undefined) {
    throw new Error(
      `${subject} needs render: what record returns is kept, so it must be JSON. Return the data from record, and render the tools or connections from it.`,
    );
  }
  if (record === undefined && render === undefined) {
    throw new Error(`${subject} requires render, or record, beside select.`);
  }
  if (typeof select !== "function") {
    throw new Error(
      `${subject} requires a select function. Use select: once to resolve once per session.`,
    );
  }
}

/**
 * Defines a value that depends on the session. `select` reads what it depends on, and `render`
 * makes the value from it. When `render` needs something to await, `record` fetches it once per
 * new selection, eve keeps what it returns, and `render` gets that instead. The folder decides
 * what the value is: tools in `agent/tools/`, skills in `agent/skills/`, and so on.
 *
 * ```ts
 * import { defineDynamic, defineTool } from "eve/tools";
 *
 * const everyone = { list_users };
 * const admins = { list_users, delete_user };
 *
 * export default defineDynamic({
 *   select: (_view, { session }) => session.auth.current?.attributes.role ?? null,
 *   render: (role) => (role === "admin" ? admins : everyone),
 * });
 * ```
 */
export const defineDynamic: DefineDynamic<unknown> = ((definition: ReactionDefinition) =>
  defineReaction(definition, "defineDynamic")) as DefineDynamic<unknown>;

const FRAMEWORK_DEFINITION = Symbol.for("eve.framework-definition");

/**
 * Marks a definition eve generates, such as a memory slot's tools: its `record` and `render` run
 * in the session's context with eve's own context, and `render` may await, as eve's internal
 * reactions do.
 */
export function asFrameworkDefinition<T extends object>(definition: T): T {
  Object.defineProperty(definition, FRAMEWORK_DEFINITION, { value: true });
  return definition;
}

export function isFrameworkDefinition(value: unknown): boolean {
  return typeof value === "object" && value !== null && FRAMEWORK_DEFINITION in value;
}

export function isDynamicSentinel(value: unknown): value is DynamicSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DYNAMIC_SENTINEL_KIND
  );
}

/** Rejects keys a slot doesn't accept beside `select`, `record`, and `render`. */
export function assertDynamicSentinelKeys(
  sentinel: DynamicSentinel,
  message: string,
  allowed: readonly string[] = [],
): void {
  assertReactionForm(sentinel, `${message} The definition`);
  const unknownKeys = Object.keys(sentinel).filter(
    (key) =>
      key !== "kind" &&
      key !== "select" &&
      key !== "record" &&
      key !== "render" &&
      !allowed.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${message} Unknown key(s): ${unknownKeys.join(", ")}.`);
  }
}
