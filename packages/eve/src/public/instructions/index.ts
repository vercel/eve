/**
 * Instructions prompt authoring helpers for `agent/instructions.ts`
 * and `agent/instructions/*.ts` files.
 */

export {
  defineInstructions,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";

export { defineDynamic } from "#public/definitions/tool.js";

export type { DynamicResolveContext, DynamicSentinel } from "#shared/dynamic-tool-definition.js";
