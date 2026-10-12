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
  DynamicSentinel,
  ReactionView,
  RecordContext,
  SelectContext,
} from "#dynamic/definition.js";

/** Named lifetimes for `select`: once per session, turn, or model call. */
export { once, perStep, perTurn } from "#dynamic/definition.js";
