import type { ChannelInfo } from "#shared/channel-info.js";
import type { HistoryMessage as ModelMessage } from "#shared/history-message.js";

import type { SessionAuth, SessionPredecessor } from "#context/keys.js";
import type {
  SessionStartedPoint,
  StepStartedPoint,
  TurnStartedPoint,
} from "#harness/session-machine/change-points.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { ConversationContext } from "#shared/conversation-context.js";

/** The change points dynamic resolvers name: a session's first turn, a turn, and each model run. */
export type DynamicToolEventName = "beforeSession" | "beforeTurn" | "beforeModel";

/** The typed fact at each resolver change point, not a subscription name. */
export type DynamicResolverEvent<K extends DynamicToolEventName> = {
  beforeSession: SessionStartedPoint["fact"];
  beforeTurn: TurnStartedPoint["fact"];
  beforeModel: StepStartedPoint["fact"];
}[K];

/** Maps private machine points to the authored resolver key. */
export function dynamicEventKey(type: DynamicScopeEvent["type"]): DynamicToolEventName {
  return type === "session.started"
    ? "beforeSession"
    : type === "turn.started"
      ? "beforeTurn"
      : "beforeModel";
}

/**
 * What a dynamic resolver's handler receives at its change point: the point's name and where the
 * session is. A private payload, not a stream event.
 */
export type DynamicScopeEvent = SessionStartedPoint | TurnStartedPoint | StepStartedPoint;

/** A session's or a turn's start: the events every resolver but the model's and tools' answers. */
export type DynamicSessionOrTurnEvent = Exclude<DynamicScopeEvent, { type: "step.started" }>;

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
  connection: ["beforeSession", "beforeTurn"],
  instructions: ["beforeSession", "beforeTurn"],
  model: ["beforeSession", "beforeTurn", "beforeModel"],
  skill: ["beforeSession", "beforeTurn"],
  subagent: ["beforeSession", "beforeTurn"],
  tool: ["beforeSession", "beforeTurn", "beforeModel"],
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
  readonly channel: ChannelInfo;
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
 *
 * Each handler receives a typed fact at its change point: `beforeSession` and `beforeTurn`
 * receive the corresponding start facts, and `beforeModel` receives `model.requested`, whose `scope` names its
 * model run and the turn it serves, or the context change for a compaction's summary run.
 */
export type DynamicEvents<TResult = unknown> = {
  readonly [K in DynamicToolEventName]?: (
    event: DynamicResolverEvent<K>,
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
 * Per-slot keys: tool and model resolvers run at `beforeSession`,
 * `beforeTurn`, and `beforeModel`. Skill, instruction, connection, and
 * subagent resolvers run only at `beforeSession` and `beforeTurn`. A
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

/** Calls the matching typed handler without discarding its discriminant. */
export function invokeDynamicResolver<TResult>(
  events: DynamicEvents<TResult>,
  point: DynamicScopeEvent,
  ctx: DynamicResolveContext,
): TResult | Promise<TResult> | undefined {
  switch (point.type) {
    case "session.started":
      return events.beforeSession?.(point.fact, ctx);
    case "turn.started":
      return events.beforeTurn?.(point.fact, ctx);
    case "step.started":
      return events.beforeModel?.(point.fact, ctx);
  }
}
