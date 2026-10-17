import {
  defineDynamic as baseDefineDynamic,
  type DynamicSentinel,
  type DynamicResolverEvent,
} from "#dynamic/definition.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import type { SkillDefinition } from "#public/definitions/skill.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
export type DynamicSkillResult = SkillDefinition | Readonly<Record<string, SkillDefinition>> | null;
export type DynamicSkillEvents = {
  readonly [K in "beforeSession" | "beforeTurn"]?: (
    event: DynamicResolverEvent<K>,
    ctx: DynamicResolveContext,
  ) => DynamicSkillResult | Promise<DynamicSkillResult>;
};
/** A skill resolver remains stable within a turn and returns only skills. */
export function defineDynamic<const TEvents extends DynamicSkillEvents>(definition: {
  readonly events: ExactDefinition<TEvents, DynamicSkillEvents>;
}): DynamicSentinel<DynamicSkillResult> {
  return baseDefineDynamic(definition) as DynamicSentinel<DynamicSkillResult>;
}
