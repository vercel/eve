import type { ModelMessage } from "ai";

import type {
  PublicToolInputSchema,
  PublicToolOutputSchema,
  ToolModelOutput,
} from "#shared/tool-definition.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { NeedsApprovalContext } from "#public/definitions/tool.js";
import type { SessionAuth } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

type ToolContext = SessionContext;

/**
 * Stream event types allowed for dynamic tool resolvers. Dispatch
 * supports any event; this extract restricts the public surface until
 * more events are validated.
 */
export type DynamicToolEventName = Extract<
  HandleMessageStreamEvent["type"],
  "session.started" | "turn.started" | "step.started"
>;

export const ALLOWED_DYNAMIC_TOOL_EVENTS: ReadonlySet<string> = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
  "step.started",
]);

/**
 * Instructions and skills are restricted to session/turn boundaries.
 * They feed the system prompt, the most cache-sensitive position in the
 * wire format; keeping them stable across steps within a turn maximizes
 * cache hits.
 */
export const ALLOWED_DYNAMIC_INSTRUCTION_EVENTS: ReadonlySet<string> =
  new Set<DynamicToolEventName>(["session.started", "turn.started"]);

export const ALLOWED_DYNAMIC_SKILL_EVENTS: ReadonlySet<string> = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
]);

/**
 * Context passed to a dynamic resolver's event handler (tools and skills).
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
 * A single tool entry within a resolved dynamic tool set.
 *
 * Identity comes from context: a single returned entry is named after
 * the file slug; entries in a returned `Record<string, DynamicToolEntry>`
 * are each named `slug__key`.
 *
 * `TInput` defaults to `Record<string, unknown>` but is inferred when
 * `inputSchema` is a Standard Schema (e.g. Zod) via the `defineTool`
 * wrapper. `TOutput` defaults to `any`; provide an `outputSchema`
 * (Standard Schema) to infer and check the executor return type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DynamicToolEntry<TInput = Record<string, unknown>, TOutput = any> {
  readonly description: string;
  readonly inputSchema: PublicToolInputSchema<TInput>;
  readonly outputSchema?: PublicToolOutputSchema<TOutput>;
  execute(input: TInput, ctx: ToolContext): TOutput | Promise<TOutput>;
  readonly toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
  /**
   * Optional per-call approval gate, mirroring the authored-tool
   * `needsApproval` contract: return `true` to require user approval
   * before the call executes. Only honored for step-scoped dynamic
   * tools, whose live `execute` closures survive into the harness;
   * session/turn-scoped tools replay from durable metadata and cannot
   * carry a function across replay.
   */
  readonly needsApproval?: (ctx: NeedsApprovalContext) => boolean;
}

/**
 * A resolved tool set: keys are entry identifiers, values are
 * {@link DynamicToolEntry} objects created via `defineTool` inside a
 * resolver. Entry type params are `any` so entries with differing
 * schemas stay assignable to one Record; `defineTool` captures each
 * entry's concrete types before this widened container.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DynamicToolSet = Readonly<Record<string, DynamicToolEntry<any, any>>>;

/**
 * Return type for a `defineDynamic` event handler: a single tool entry
 * (named after the file slug), a map of entries (named `slug__key`), or
 * `null` for no tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DynamicToolResult = DynamicToolEntry<any, any> | DynamicToolSet | null;

/**
 * Strongly-typed tool-handler map: each key is a supported event name,
 * each value a resolver that takes the stream event and resolve context
 * and returns a {@link DynamicToolResult}. `defineDynamic` accepts the
 * wider {@link DynamicEvents} (handlers return `unknown`) because the
 * slot directory (tools/ vs skills/) decides the expected return at
 * runtime. Reference `DynamicToolEvents` to check the tool-specific
 * return type at authoring time.
 */
export type DynamicToolEvents = {
  readonly [K in DynamicToolEventName]?: (
    event: unknown,
    ctx: DynamicResolveContext,
  ) => DynamicToolResult | Promise<DynamicToolResult>;
};

/**
 * Base event handler map accepted by `defineDynamic`. Intentionally
 * wide so it accepts both tool-returning and skill-returning handlers:
 * the slot directory (tools/ vs skills/) determines the required return,
 * validated at runtime by the respective resolver.
 */
export type DynamicEvents = {
  readonly [K in DynamicToolEventName]?: (
    event: unknown,
    ctx: DynamicResolveContext,
  ) => unknown | Promise<unknown>;
};

/**
 * Marker discriminator for a `defineDynamic({ events })` export.
 */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/**
 * Return value of `defineDynamic`: the runtime shape of a
 * `defineDynamic({ events })` export, stamped with a sentinel kind the
 * compiler/normalizer detects.
 */
export interface DynamicSentinel {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly events: DynamicEvents;
}

export function isDynamicSentinel(value: unknown): value is DynamicSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DYNAMIC_SENTINEL_KIND
  );
}

/**
 * Symbol-based brand stamped by `defineTool` on every entry. Invisible
 * in IntelliSense, checked at runtime to enforce the wrapper and to
 * distinguish a single entry from a map of entries.
 */
export const TOOL_BRAND = Symbol.for("eve:tool-brand");

/**
 * Returns true if `value` carries the `defineTool` brand symbol. Used
 * to detect single entry vs map of entries and to validate that entries
 * are properly wrapped.
 */
export function isBrandedToolEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[TOOL_BRAND] === true
  );
}

/**
 * Symbol-based brand stamped by `defineInstructions` on every entry.
 * Invisible in IntelliSense, checked at runtime to validate that dynamic
 * instruction resolver returns are properly wrapped.
 */
export const INSTRUCTIONS_BRAND = Symbol.for("eve:instructions-brand");

/**
 * Returns true if `value` carries the `defineInstructions` brand symbol.
 * Used to validate that dynamic instruction entries are properly wrapped.
 */
export function isBrandedInstructionsEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[INSTRUCTIONS_BRAND] === true
  );
}

/**
 * Symbol-based brand stamped by `defineSkill` on every entry. Invisible
 * in IntelliSense, checked at runtime to detect single-entry vs
 * map-of-entries return shapes in dynamic skill resolvers.
 */
export const SKILL_BRAND = Symbol.for("eve:skill-brand");

/**
 * Returns true if `value` carries the `defineSkill` brand symbol. Used
 * to detect single entry vs map of entries and to validate that entries
 * are properly wrapped.
 */
export function isBrandedSkillEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SKILL_BRAND] === true
  );
}
