import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import {
  DYNAMIC_SENTINEL_KIND,
  type DynamicResolveContext,
  type DynamicSentinel,
} from "#dynamic/definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import {
  INSTRUCTIONS_BRAND,
  type PublicInstructionsDefinition,
} from "#shared/instructions-definition.js";

export type InstructionsDefinition = Readonly<PublicInstructionsDefinition>;

/**
 * Defines instructions in TypeScript from a `{ content, role? }`
 * definition. Omitted `role` defaults to `"system"`.
 *
 * Use it to return instructions from a `defineDynamic` resolver in
 * `agent/instructions/`. For a fixed prompt with no resolver,
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

export type DynamicInstructionsResult = InstructionsDefinition | null;

export type DynamicInstructionsEvents = {
  readonly [K in "session.started" | "turn.started"]?: (
    event: unknown,
    ctx: DynamicResolveContext,
  ) => DynamicInstructionsResult | Promise<DynamicInstructionsResult>;
};

/**
 * Defines a runtime instructions resolver for session and turn boundaries.
 */
export function defineDynamic<const TEvents extends DynamicInstructionsEvents>(definition: {
  readonly events: ExactDefinition<TEvents, DynamicInstructionsEvents>;
}): DynamicSentinel<DynamicInstructionsResult> {
  const sentinel = {
    kind: DYNAMIC_SENTINEL_KIND,
    events: definition.events,
  } as DynamicSentinel<DynamicInstructionsResult>;
  stampDefinitionKey(sentinel, `dynamic-instructions:${Object.keys(definition.events).join(",")}`);
  return sentinel;
}
