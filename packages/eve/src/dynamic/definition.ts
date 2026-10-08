import type { ModelMessage } from "ai";

import type { SessionAuth, SessionPredecessor } from "#context/keys.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ConversationContext } from "#shared/conversation-context.js";

/**
 * Stream event types allowed for dynamic tool resolvers. Dispatch
 * supports any event; this extract restricts the public surface until
 * more events are validated.
 */
export type DynamicToolEventName = Extract<
  UnstampedMessageStreamEvent["type"],
  "session.started" | "turn.started" | "step.started"
>;

/** The event a dynamic resolver answers: a session's start, a turn's, or one model call's. */
export type DynamicScopeEvent = Extract<
  UnstampedMessageStreamEvent,
  { type: DynamicToolEventName }
>;

/** The kinds of dynamic resolver, by the slot they're authored in. */
export type DynamicResolverKind =
  | "connection"
  | "instructions"
  | "model"
  | "skill"
  | "subagent"
  | "tool";

/**
 * The events each kind of dynamic resolver handles. Instructions, skills, connections, and
 * subagents stay stable within a turn, so the model input doesn't change between its steps.
 */
export const DYNAMIC_RESOLVER_EVENTS = {
  connection: ["session.started", "turn.started"],
  instructions: ["session.started", "turn.started"],
  model: ["session.started", "turn.started", "step.started"],
  skill: ["session.started", "turn.started"],
  subagent: ["session.started", "turn.started"],
  tool: ["session.started", "turn.started", "step.started"],
} as const satisfies Record<DynamicResolverKind, readonly DynamicToolEventName[]>;

/** Fails the build when a resolver of `kind` handles an event it never receives. */
export function assertDynamicResolverEvents(
  kind: DynamicResolverKind,
  eventNames: readonly string[],
  message: string,
): void {
  const supported: readonly string[] = DYNAMIC_RESOLVER_EVENTS[kind];
  const unsupported = eventNames.find((eventName) => !supported.includes(eventName));
  if (unsupported === undefined) return;
  const names = supported.map((eventName) => `"${eventName}"`);
  throw new Error(
    `${message} Dynamic ${kind} resolvers support only ${names.slice(0, -1).join(", ")} and ${names.at(-1)!} handlers. Unsupported event: "${unsupported}".`,
  );
}

/**
 * Context passed to a dynamic resolver's event handler.
 *
 * Exposes read-only session identity, auth, and channel metadata. State
 * is not exposed here; resolvers read it through `defineState` handles or
 * the session context inside tool `execute` functions.
 */
export interface DynamicResolveContext {
  /** Active cancellation signal when resolving a dynamic model. */
  readonly abortSignal?: AbortSignal;
  /** Effective model for this resolver, or `null` before dynamic model selection. */
  readonly model: { readonly id: string } | null;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly schedule?: import("#context/session-schedule.js").SessionSchedule;
    /**
     * Present when eve started this session in place of a stranded session,
     * one that another eve version built. It names the earlier session, whose recorded stream
     * `sessions.attach(predecessor.sessionId)` from `eve/server` reads.
     */
    readonly predecessor?: SessionPredecessor;
  };
  /** Channel metadata for the request that triggered this resolve. */
  readonly channel: {
    /** Channel type that produced the request (e.g. `"slack"`, `"http"`), when known. */
    readonly kind?: string;
    /** Channel-owned resume handle for the conversation, when the channel supplies one. */
    readonly continuationToken?: string;
    /** Free-form channel-specific metadata attached to the request. */
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  /**
   * Immutable classification and execution context for the active conversation.
   * Absent on sessions persisted before this context key existed.
   */
  readonly conversation?: ConversationContext;
  /** Conversation history visible at this resolve point, oldest first. */
  readonly messages: readonly ModelMessage[];
}

/**
 * Base event handler map accepted by `defineDynamic`. Intentionally
 * wide so it accepts both tool-returning and skill-returning handlers:
 * the slot directory (tools/ vs skills/) determines the required return,
 * validated at runtime by the respective resolver.
 */
export type DynamicEvents<TResult = unknown> = {
  readonly [K in DynamicToolEventName]?: (
    event: unknown,
    ctx: DynamicResolveContext,
  ) => TResult | Promise<TResult>;
};

type DynamicEventMapHandler<TEvents extends DynamicEvents> = Extract<
  NonNullable<TEvents[keyof TEvents]>,
  (...args: never[]) => unknown
>;
type DynamicEventMapResult<TEvents extends DynamicEvents> = Awaited<
  ReturnType<DynamicEventMapHandler<TEvents>>
>;

/**
 * Marker discriminator for a `defineDynamic({ events })` export.
 */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/**
 * Return value of `defineDynamic`: the runtime shape of a dynamic export,
 * stamped with a sentinel kind the compiler/normalizer detects.
 */
export type DynamicSentinel<TResult = unknown> = {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly events: DynamicEvents<TResult>;
};

/**
 * Defines a dynamic resolver evaluated at runtime from stream-event
 * handlers. It is shared across tools, skills, connections, and agent definitions;
 * the directory it is authored in (not this function) decides what each
 * handler must return and which events are honored. The file's path-derived
 * slug names the single-entry case; a `Record<string, ...>` return names each
 * entry by its bare key, prefixed with the mount namespace for an extension's
 * resolver. Return `null` to contribute nothing for that event.
 *
 * Per-slot return shape:
 * - `agent/tools/`: return a single `defineTool(...)`, a
 *   `Record<string, defineTool(...)>`, or `null`.
 * - `agent/skills/`: return a single `defineSkill(...)`, a
 *   `Record<string, defineSkill(...)>`, or `null`.
 * - `agent/connections/`: return one connection definition, a
 *   `Record<string, connection definition>`, or `null`.
 * - `agent/subagents/<name>/agent.ts`: return `defineAgent(...)` to configure
 *   and expose the subagent, or `null` to omit it.
 *
 * Per-slot events: tool and model resolvers run at `session.started`,
 * `turn.started`, and `step.started`. Skill, instruction, connection, and
 * subagent resolvers run only at `session.started` and `turn.started`. A
 * handler keyed on any other event fails the build.
 *
 * ```ts
 * import { defineDynamic, defineTool } from "eve/tools";
 * import { z } from "zod";
 *
 * export default defineDynamic({
 *   events: {
 *     "session.started": async (event, ctx) => ({
 *       export: defineTool({
 *         description: "Export data",
 *         inputSchema: z.object({ format: z.string() }),
 *         async execute(input) {
 *           return doExport(input.format);
 *         },
 *       }),
 *     }),
 *   },
 * });
 * ```
 *
 * A single return is named after the file slug. A map names each entry by its
 * bare key — there is no automatic slug prefix, so namespace keys yourself
 * (e.g. `team__playbook`) when a bare name might collide. Tool names must match
 * the tool filename charset, and a name under a connection's `<name>__` prefix
 * is rejected. A dynamic tool/skill whose name matches an authored one
 * overrides it; two dynamic resolvers emitting the same name is an error.
 */
export function defineDynamic<const TEvents extends DynamicEvents>(definition: {
  readonly events: TEvents;
}): DynamicSentinel<DynamicEventMapResult<TEvents>>;
export function defineDynamic<TResult = unknown>(definition: {
  readonly events: DynamicEvents<TResult>;
}): DynamicSentinel<TResult> {
  const sentinel = {
    kind: DYNAMIC_SENTINEL_KIND,
    events: definition.events,
  } as DynamicSentinel<TResult>;
  stampDefinitionKey(sentinel, `dynamic:${Object.keys(definition.events).join(",")}`);
  return sentinel;
}

export function assertResolverOnlyDynamicSentinel(
  sentinel: DynamicSentinel,
  message: string,
): void {
  const unknownKeys = Object.keys(sentinel).filter((key) => key !== "events" && key !== "kind");
  if (unknownKeys.length > 0) {
    throw new Error(`${message} Unknown key(s): ${unknownKeys.join(", ")}.`);
  }
}

export function isDynamicSentinel(value: unknown): value is DynamicSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DYNAMIC_SENTINEL_KIND
  );
}
