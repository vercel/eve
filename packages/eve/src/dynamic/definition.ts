import type { ModelMessage } from "ai";

import type { SessionAuth, SessionPredecessor } from "#context/keys.js";
import type { SessionSchedule } from "#context/session-schedule.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { ConversationContext } from "#shared/conversation-context.js";

/**
 * What a reaction selects from: the session's tables, the position of the latest event of each
 * type, the effective model, and the conversation.
 *
 * `messages` is the conversation as the model sees it. Steps that run without the conversation,
 * such as a task settling between turns, skip a reaction whose `select` reads it; the reaction runs
 * again after the next commit that has it.
 */
export interface ReactionView extends SessionView {
  /** The line position of the latest event of each type, and `"*"` for the latest fact. */
  readonly latest: Readonly<Record<string, number | undefined>>;
  /** The model the session uses now, or `null` before one is chosen. */
  readonly model: { readonly id: string } | null;
  readonly messages: readonly ModelMessage[];
}

/** The session's identity, auth, and channel, for `select` and `resolve`. */
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
 * What `resolve` receives besides its selection. `resolve` is a function of its selection: eve
 * may call it again with the same selection at any time, such as to rebuild code in another
 * process, so it gets no facts. Read facts in a hook's `events` handlers.
 */
export interface ResolveContext extends SelectContext {
  readonly abortSignal: AbortSignal;
}

/** Reads what a reaction depends on. Synchronous and deterministic; returns JSON. */
export type ReactionSelect<TSelected, TView = ReactionView> = (
  view: TView,
  ctx: SelectContext,
) => TSelected;

/** Returns what a reaction contributes, given what its `select` read. */
export type ReactionResolve<TSelected, TResult> = (
  selected: TSelected,
  ctx: ResolveContext,
) => TResult | Promise<TResult>;

/** Marker discriminator for a `defineDynamic()` or `defineHook()` export. */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/** A `defineDynamic()` export, which the compiler detects by its `kind`. */
export interface DynamicSentinel<TResult = unknown, TSelected = unknown> {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly select: ReactionSelect<TSelected>;
  readonly resolve: ReactionResolve<TSelected, TResult>;
}

/**
 * The `select` and `resolve` pair `defineDynamic()` accepts. `select` is required: return `null`
 * from it to resolve once per session.
 */
export interface DynamicDefinition<TSelected, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly resolve: ReactionResolve<TSelected, TResult>;
}

/** `defineDynamic()` typed for the slot it is authored in. */
export type DefineDynamic<TResult> = <TSelected, TStatic extends object = object>(
  definition: DynamicDefinition<TSelected, TResult> & TStatic,
) => DynamicSentinel<TResult, TSelected> & TStatic;

/**
 * The one definition every authored reaction compiles from: `select` and `resolve`, or a map of
 * `events` handlers, never both. `defineDynamic()` and `defineHook()` narrow it: a slot's folder
 * takes `select` and `resolve` returning its kind, and a hook takes either form returning intents.
 */
export type ResolverDefinition =
  | {
      readonly select: (...args: never[]) => unknown;
      readonly resolve: (...args: never[]) => unknown;
      readonly events?: never;
    }
  | {
      readonly events: Readonly<Record<string, unknown>>;
      readonly select?: never;
      readonly resolve?: never;
    };

/** Validates a resolver's form and marks it for the compiler. Not public: use its narrowings. */
export function defineResolver<T extends ResolverDefinition>(
  definition: T,
  name: string,
): T & { readonly kind: typeof DYNAMIC_SENTINEL_KIND } {
  assertResolverForm(definition, `${name}()`);
  const sentinel = { ...definition, kind: DYNAMIC_SENTINEL_KIND };
  stampDefinitionKey(sentinel, "dynamic");
  return sentinel;
}

/**
 * Throws unless `value` takes exactly one form: `select` and `resolve` functions, or an `events`
 * object. Both the definers and the compiler use it, so every source of a resolver agrees.
 */
export function assertResolverForm(
  value: unknown,
  subject: string,
  options: { readonly events?: boolean } = { events: true },
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${subject} takes an object.`);
  }
  const { events, resolve, select } = value as Record<string, unknown>;
  if (events !== undefined) {
    if (options.events === false) {
      throw new Error(`${subject} takes select and resolve, not events.`);
    }
    if (select !== undefined || resolve !== undefined) {
      throw new Error(`${subject} takes either events or select and resolve, not both.`);
    }
    if (typeof events !== "object" || events === null) {
      throw new Error(`${subject} events must be an object of handlers.`);
    }
    return;
  }
  if (typeof resolve !== "function") {
    throw new Error(
      options.events === false
        ? `${subject} requires a resolve function.`
        : `${subject} requires events, or select and resolve.`,
    );
  }
  if (typeof select !== "function") {
    throw new Error(
      `${subject} requires a select function beside resolve. Return null from select to resolve once per session.`,
    );
  }
}

/**
 * Defines what a file contributes as a function of the session. `select` reads what the result
 * depends on, and `resolve` returns the file's contribution; eve calls `resolve` again only when
 * the selection changes. The directory decides what `resolve` returns: tools in `agent/tools/`,
 * skills in `agent/skills/`, and so on. A single definition is named after the file; a map names
 * each entry by its key. Return `null` to contribute nothing, and from `select` to resolve once.
 *
 * ```ts
 * import { defineDynamic, defineTool } from "eve/tools";
 *
 * export default defineDynamic({
 *   select: (view) => view.latest["turn.started"] ?? null,
 *   resolve: async () =>
 *     Object.fromEntries((await listTables()).map((table) => [table.name, tableTool(table)])),
 * });
 * ```
 */
export function defineDynamic<TResult = unknown, TSelected = null, TStatic extends object = object>(
  definition: DynamicDefinition<TSelected, TResult> & TStatic,
): DynamicSentinel<TResult, TSelected> & TStatic {
  assertResolverForm(definition, "defineDynamic()", { events: false });
  return defineResolver(
    definition as DynamicDefinition<TSelected, TResult> & TStatic & ResolverDefinition,
    "defineDynamic",
  ) as unknown as DynamicSentinel<TResult, TSelected> & TStatic;
}

export function isDynamicSentinel(value: unknown): value is DynamicSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DYNAMIC_SENTINEL_KIND
  );
}

/** Rejects keys a slot doesn't accept beside `select` and `resolve`. */
export function assertDynamicSentinelKeys(
  sentinel: DynamicSentinel,
  message: string,
  allowed: readonly string[] = [],
): void {
  assertResolverForm(sentinel, `${message} The definition`, { events: false });
  const unknownKeys = Object.keys(sentinel).filter(
    (key) => key !== "kind" && key !== "select" && key !== "resolve" && !allowed.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${message} Unknown key(s): ${unknownKeys.join(", ")}.`);
  }
}
