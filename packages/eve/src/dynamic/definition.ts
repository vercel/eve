import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";
import type { HistoryMessage as ModelMessage } from "#shared/history-message.js";

import type { SessionAuth, SessionParent, SessionPredecessor } from "#context/keys.js";
import type { SessionSchedule } from "#context/session-schedule.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { SessionView } from "#protocol/session-projection/session-view.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { ConversationContext } from "#shared/conversation-context.js";

/**
 * The session's latest turn, running or not. Its `id` keys a memo that runs once per turn: it
 * stays the same through the turn's tool calls, pauses, and steering, until the next turn starts.
 */
export interface DynamicTurn {
  readonly id: string;
  readonly status: "running" | "paused" | "settled";
  /** The parts of the messages the turn opened with. Messages that steer it later don't count. */
  readonly input: readonly UserPart[];
}

/**
 * One run of a memo or a hook handler. A retry of the same run, after a process failed
 * before its step was saved, has the same `idempotencyKey`.
 *
 * A memo's `idempotencyKey` is stable per session, definition, and memo key: it also repeats
 * when the same key runs again after a deployment change discarded its result, or after an
 * evaluation that didn't use it. A service that honors the key answers those runs with its first
 * response; when a run needs fresh data, send a key of your own instead.
 */
export interface Occurrence {
  /** Pass it to an external service, so a retried effect doesn't happen twice. */
  readonly idempotencyKey: string;
  readonly abortSignal: AbortSignal;
}

/**
 * A memo key: any JSON value, compared as canonical JSON, such as a tenant ID or
 * `["tables", ctx.session.id]`. `undefined` reads as `null`.
 */
export type DynamicKey = unknown;

/**
 * Runs `fn` the first time the session sees `key` from this definition, keeps the JSON it returns,
 * and returns the kept result for the same key afterwards, in any process. Only the keys the
 * latest successful evaluation used stay kept, and a deployment change discards them: a key used
 * again after either runs `fn` again. Code outside a memo runs again at every evaluation.
 */
export type Memo = <T>(
  key: DynamicKey,
  fn: (occurrence: Occurrence) => T | Promise<T>,
) => Promise<T>;

/** The session as of its latest commit: what every dynamic value and hook handler reads. */
export interface SessionFrame {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    /** Present only for scheduled work. */
    readonly schedule?: SessionSchedule;
    /**
     * Present when eve started this session in place of a stranded session, one that another eve
     * version built. It names the earlier session, whose recorded stream
     * `sessions.attach(predecessor.sessionId)` from `eve/server` reads.
     */
    readonly predecessor?: SessionPredecessor;
    /**
     * Present only in a delegated session. `sessionId`, `callId`, and `turn` name the immediate
     * parent and the call that opened this session; `rootSessionId` names the top-level session.
     */
    readonly parent?: SessionParent;
  };
  /** Channel metadata for the request that triggered this resolve. */
  readonly channel: InstrumentationChannel;
  /**
   * Immutable classification and execution context for the active conversation.
   * Absent on sessions persisted before this context key existed.
   */
  readonly conversation?: ConversationContext;
  /** The session's tables, as a client folds them from the stream. */
  readonly view: SessionView;
  /** The session's latest turn, or `null` before its first. */
  readonly turn: DynamicTurn | null;
  /** The time of the session's latest commit, so it reads the same in every process. */
  readonly now: Date;
}

/** What a dynamic agent `model` reads. The model isn't chosen yet, so there's no `ctx.model`. */
export interface DynamicModelContext extends SessionFrame {
  readonly memo: Memo;
  /** The conversation history as of the latest commit, assembled when something reads it. */
  messages(): Promise<readonly ModelMessage[]>;
}

/** What a dynamic value reads: the session as of its latest commit, and the model chosen for it. */
export interface DynamicContext extends DynamicModelContext {
  /** The model chosen for the session. */
  readonly model: { readonly id: string };
}

/** Marker discriminator for a `defineDynamic()` export. */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/** A `defineDynamic()` value, which the compiler detects by its `kind`. */
export interface DynamicSentinel<TResult = unknown, TContext = DynamicContext> {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly evaluate: (ctx: TContext) => TResult | Promise<TResult>;
}

/** `defineDynamic()` typed for the folder it's authored in. */
export type DefineDynamic<TResult, TContext = DynamicContext> = (
  fn: (ctx: TContext) => TResult | Promise<TResult>,
) => DynamicSentinel<TResult, TContext>;

/**
 * Defines a value that depends on the session: a function of the session as of its latest
 * commit. eve calls it in each step that needs the value, before each model call today, and
 * installs what it returns, or nothing for `null`. The folder or field decides what it returns:
 * tools in `agent/tools/`, skills in `agent/skills/`, a model in an agent's `model` field.
 *
 * Work that shouldn't repeat goes in `ctx.memo(key, fn)`: `fn` runs once per key, and a later
 * evaluation, in any process, gets the result it kept.
 *
 * ```ts
 * import { defineDynamic } from "eve/tools";
 *
 * export default defineDynamic(async (ctx) => {
 *   const tenantId = ctx.session.auth.current?.attributes.tenantId;
 *   if (!tenantId) return null;
 *   const rows = await ctx.memo(tenantId, () => db.crmTools(tenantId));
 *   return Object.fromEntries(rows.map((row) => [row.slug, crmTool(row)]));
 * });
 * ```
 */
export function defineDynamic<TResult, TContext extends DynamicModelContext = DynamicContext>(
  fn: (ctx: TContext) => TResult | Promise<TResult>,
): DynamicSentinel<TResult, TContext> {
  assertDynamicFunction(fn, "defineDynamic()");
  const sentinel = { evaluate: fn, kind: DYNAMIC_SENTINEL_KIND };
  stampDefinitionKey(sentinel, "dynamic");
  return sentinel;
}

function assertDynamicFunction(value: unknown, subject: string): void {
  if (typeof value === "function") return;
  if (typeof value === "object" && value !== null && "events" in value) {
    throw new Error(
      `${subject} takes a function of the session, not an events map: defineDynamic(async (ctx) => value). Key work that should run once per session, turn, or tenant with ctx.memo(key, fn).`,
    );
  }
  throw new Error(`${subject} takes a function: defineDynamic(async (ctx) => value).`);
}

const FRAMEWORK_DEFINITION = Symbol.for("eve.framework-definition");

/**
 * Marks a definition eve generates, such as a memory slot's tools: its function receives eve's
 * own evaluation context, with the step's state.
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

/**
 * Throws unless `sentinel` is a `defineDynamic(fn)` value: the function and nothing beside it.
 * The compiler and the runtime loader both use it, so every source agrees.
 */
export function assertDynamicSentinelKeys(sentinel: DynamicSentinel, message: string): void {
  assertDynamicFunction(sentinel.evaluate ?? sentinel, `${message} defineDynamic()`);
  const unknownKeys = Object.keys(sentinel).filter((key) => key !== "kind" && key !== "evaluate");
  if (unknownKeys.length > 0) {
    throw new Error(
      `${message} defineDynamic() takes only a function; unknown key(s): ${unknownKeys.join(", ")}. Packaging configuration such as build.externalDependencies belongs on the root agent.ts.`,
    );
  }
}
