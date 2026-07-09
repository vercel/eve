import { DynamicSkillManifestKey, StaticSkillNamesKey } from "#context/keys.js";
import type { ContextReader } from "#context/provider.js";

/**
 * Returns the skill names visible to the active agent.
 *
 * Static names are seeded from the active runtime node at run bootstrap.
 * Dynamic names come from the durable dynamic skill manifest. The sandbox may
 * contain additional files when a child inherits a parent sandbox, so callers
 * must use this list as the authority for skill access.
 */
export function getAvailableSkillNames(ctx: ContextReader): string[] {
  const staticNames = ctx.get(StaticSkillNamesKey) ?? [];
  const dynamicNames = Object.values(ctx.get(DynamicSkillManifestKey) ?? {})
    .flat()
    .map((skill) => skill.name);

  return [...new Set([...staticNames, ...dynamicNames])].sort();
}
