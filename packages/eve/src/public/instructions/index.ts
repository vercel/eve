/**
 * Instructions prompt authoring helpers for `agent/instructions.ts`
 * and `agent/instructions/*.ts` files.
 */

export {
  defineDynamic,
  defineInstructions,
  type DynamicInstructionsResult,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";

export type {
  DynamicContext,
  DynamicKey,
  DynamicModelContext,
  DynamicSentinel,
  DynamicTurn,
  Memo,
  Occurrence,
  SessionFrame,
} from "#dynamic/definition.js";
