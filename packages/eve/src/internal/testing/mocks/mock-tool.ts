import type { SessionContext } from "#public/definitions/callback-context.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#shared/tool-schema.js";

/**
 * Declarative description of one synthetic authored tool used by the
 * AppHarness.
 *
 * The builder fills in sensible defaults (kebab-case logical path, derived
 * source id, permissive input schema) so most tests can supply just a name
 * and an `execute` function. Everything else is overrideable.
 */
export interface MockToolInput {
  /** Tool name exposed to the model. */
  readonly name: string;
  /** Human-readable description surfaced in the prompt. */
  readonly description?: string;
  /**
   * Optional JSON-schema input. Defaults to `null`, matching tools that
   * accept no inputs. Pass `{ additionalProperties: false, properties: { ... } }`
   * for tools that care.
   */
  readonly inputSchema?: JsonObject | null;
  /**
   * Tool body. Mirrors the authored tool signature: `(input, ctx)`.
   * The wrapper calls `buildCallbackContext()` at execution time,
   * matching the real pipeline in `node-step.ts`.
   *
   * When omitted the tool exists in the registry but is not executable —
   * useful for tests that assert on tool visibility without triggering a
   * call.
   */
  readonly execute?: (input: unknown, ctx: SessionContext) => Promise<unknown> | unknown;
  /**
   * Optional logical path override. Defaults to `tools/<name>.ts` with any
   * unsafe filesystem characters scrubbed.
   */
  readonly logicalPath?: string;
}

/**
 * Builds a fully-typed {@link ResolvedToolDefinition} from a compact
 * descriptor suitable for tests. The returned object is directly
 * compatible with `createRuntimeToolRegistry({ tools: [mockTool(...)] })`.
 */
export function mockTool(input: MockToolInput): ResolvedToolDefinition {
  const logicalPath = input.logicalPath ?? `tools/${sanitizeLogicalPathSegment(input.name)}.ts`;
  const definition: ResolvedToolDefinition = {
    description: input.description ?? `${input.name} mock tool.`,
    inputSchema: toInputSchema(input.inputSchema ?? null),
    logicalPath,
    name: input.name,
    sourceId: logicalPath,
    sourceKind: "module",
  };

  if (input.execute === undefined) {
    return definition;
  }

  const authoredExecute = input.execute;

  return {
    ...definition,
    execute: (rawInput) => authoredExecute(rawInput, buildCallbackContext()),
  };
}

function sanitizeLogicalPathSegment(name: string): string {
  // Tool names use a permissive charset (letters, digits, underscore, dash).
  // Pass that set through unchanged and collapse anything else to `-` so the
  // derived logical path stays a valid filename fragment.
  return name.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}
