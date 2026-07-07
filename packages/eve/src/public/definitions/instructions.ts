import { INSTRUCTIONS_BRAND } from "#shared/dynamic-tool-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { PublicInstructionsDefinition } from "#shared/instructions-definition.js";

export type InstructionsDefinition = Readonly<PublicInstructionsDefinition>;

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
