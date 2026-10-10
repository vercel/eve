import type { ModelMessage } from "ai";

import type { SessionAuth, SessionPredecessor } from "#context/keys.js";
import type { SessionSchedule } from "#context/session-schedule.js";
import type { SessionEvent } from "#protocol/session-event.js";
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

/** What `resolve` receives besides its selection. */
export interface ResolveContext extends SelectContext {
  readonly abortSignal: AbortSignal;
  /** The events of the commit after which `resolve` runs. */
  readonly facts: readonly SessionEvent[];
}

/** Reads what a reaction depends on. Synchronous and deterministic; returns JSON. */
export type ReactionSelect<TSelected> = (view: ReactionView, ctx: SelectContext) => TSelected;

/** Returns what a reaction contributes, given what its `select` read. */
export type ReactionResolve<TSelected, TResult> = (
  selected: TSelected,
  ctx: ResolveContext,
) => TResult | Promise<TResult>;

/** Marker discriminator for a `defineDynamic()` export. */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/** A `defineDynamic()` export, which the compiler detects by its `kind`. */
export interface DynamicSentinel<TResult = unknown, TSelected = unknown> {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly select?: ReactionSelect<TSelected>;
  readonly resolve: ReactionResolve<TSelected, TResult>;
}

/** The `select` and `resolve` pair `defineDynamic()` accepts, plus static fields some slots take. */
export interface DynamicDefinition<TSelected, TResult> {
  /** Omit to resolve once per session. */
  readonly select?: ReactionSelect<TSelected>;
  readonly resolve: ReactionResolve<TSelected, TResult>;
}

/** `defineDynamic()` typed for the slot it is authored in. */
export type DefineDynamic<TResult> = <TSelected = null, TStatic extends object = object>(
  definition: DynamicDefinition<TSelected, TResult> & TStatic,
) => DynamicSentinel<TResult, TSelected> & TStatic;

/**
 * Defines what a file contributes as a function of the session. `select` reads what the result
 * depends on, and `resolve` returns the file's contribution; eve calls `resolve` again only when
 * the selection changes. The directory decides what `resolve` returns: tools in `agent/tools/`,
 * skills in `agent/skills/`, and so on. A single definition is named after the file; a map names
 * each entry by its key. Return `null` to contribute nothing.
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
  if (typeof definition.resolve !== "function") {
    throw new Error("defineDynamic() requires a resolve function.");
  }
  if (definition.select !== undefined && typeof definition.select !== "function") {
    throw new Error("defineDynamic() select must be a function.");
  }
  const sentinel = { ...definition, kind: DYNAMIC_SENTINEL_KIND } as DynamicSentinel<
    TResult,
    TSelected
  > &
    TStatic;
  stampDefinitionKey(sentinel, "dynamic");
  return sentinel;
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
  const unknownKeys = Object.keys(sentinel).filter(
    (key) => key !== "kind" && key !== "select" && key !== "resolve" && !allowed.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${message} Unknown key(s): ${unknownKeys.join(", ")}.`);
  }
}
