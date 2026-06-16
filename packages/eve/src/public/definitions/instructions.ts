import { INSTRUCTIONS_BRAND } from "#shared/dynamic-tool-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";

/**
 * Public definition for an instructions prompt authored in markdown or
 * TypeScript.
 *
 * Authored at the agent root as either `instructions.md` or
 * `instructions.{ts,cts,mts,js,cjs,mjs}`, or inside the
 * `agent/instructions/` directory for multi-file setups. Module-backed
 * static instructions execute once at build time. The compiler captures
 * the resulting markdown into the compiled manifest.
 *
 * When used inside a `defineDynamic` handler, the runtime lowers the
 * returned markdown to `{ role: "system", content: markdown }`.
 * Instructions produce system messages only. Use channel `context` for
 * user-role messages.
 */
export interface InstructionsDefinition {
  readonly markdown: string;
}

/**
 * Defines an instructions prompt in TypeScript from a `{ markdown }`
 * definition.
 *
 * Use it to return instructions from a `defineDynamic` resolver in
 * `agent/instructions/`; the returned markdown lowers to a single
 * `{ role: "system" }` message. For a fixed prompt with no resolver,
 * author `instructions.md` instead. The result is branded so the dynamic
 * instruction lifecycle can validate that a resolver return came through
 * this helper.
 */
export function defineInstructions<TInstructions extends InstructionsDefinition>(
  definition: ExactDefinition<TInstructions, InstructionsDefinition>,
): TInstructions {
  Object.assign(definition, { [INSTRUCTIONS_BRAND]: true });
  return definition;
}
