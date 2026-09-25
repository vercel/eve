/**
 * Instructions prompt authoring helpers for `agent/instructions.ts`
 * and `agent/instructions/*.ts` files.
 */

export {
  defineDynamic,
  defineInstructions,
  type DynamicInstructionsEvents,
  type DynamicInstructionsResult,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";

export type { DynamicResolveContext, DynamicSentinel } from "#dynamic/definition.js";
