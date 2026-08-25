import type { ModelMessage } from "ai";

import type { SessionAuth } from "#context/keys.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/**
 * Stream event types allowed for dynamic tool resolvers. Dispatch
 * supports any event; this extract restricts the public surface until
 * more events are validated.
 */
export type DynamicToolEventName = Extract<
  UnstampedMessageStreamEvent["type"],
  "session.started" | "turn.started" | "step.started"
>;

export const ALLOWED_DYNAMIC_TOOL_EVENTS: ReadonlySet<string> = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
  "step.started",
]);

/**
 * Instructions and skills are restricted to session/turn boundaries.
 * Keeping their resolved context stable within a turn avoids changing the
 * model input between tool-loop steps.
 */
export const ALLOWED_DYNAMIC_INSTRUCTION_EVENTS: ReadonlySet<string> =
  new Set<DynamicToolEventName>(["session.started", "turn.started"]);

export const ALLOWED_DYNAMIC_SKILL_EVENTS: ReadonlySet<string> = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
]);

/**
 * Context passed to a dynamic resolver's event handler.
 *
 * Exposes read-only session identity, auth, and channel metadata. State
 * is not exposed here; resolvers read it through `defineState` handles or
 * the session context inside tool `execute` functions.
 */
export interface DynamicResolveContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
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
 * handlers. It is shared across tools, skills, and agent definitions;
 * the directory it is authored in (not this function) decides what each
 * handler must return and which events are honored. The file's path-derived
 * slug names the single-entry case; a `Record<string, ...>` return names
 * entries `slug__key`. Return `null` to contribute nothing for that event.
 *
 * Per-slot return shape:
 * - `agent/tools/`: return a single `defineTool(...)`, a
 *   `Record<string, defineTool(...)>`, or `null`.
 * - `agent/skills/`: return a single `defineSkill(...)`, a
 *   `Record<string, defineSkill(...)>`, or `null`.
 * - `agent/subagents/<name>/agent.ts`: return `defineAgent(...)` to configure
 *   and expose the subagent, or `null` to omit it.
 *
 * Per-slot events: tools resolvers run at `session.started`,
 * `turn.started`, and `step.started`. Skills resolvers run only at
 * `session.started` and `turn.started`; the runtime never invokes a
 * handler keyed on `step.started` in that slot. Dynamic subagents run at
 * `session.started` and `turn.started` only.
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
 * (e.g. `team__playbook`) when a bare name might collide. A dynamic tool/skill
 * whose name matches an authored one overrides it; two dynamic resolvers
 * emitting the same name is an error.
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
