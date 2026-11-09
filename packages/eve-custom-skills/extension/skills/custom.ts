import { defineDynamic, defineSkill, type DynamicContext } from "eve/skills";

import { loadTurnSkills } from "../lib/runtime.ts";
import { loadName } from "../lib/tool-support.ts";

/**
 * Advertises the turn's on-demand and deferred custom skills so `eve__skill`
 * can load them. eve names each entry `<mount>__<key>`, so a custom skill can
 * never shadow one of the agent's own skills, and a scope prefix joins with
 * `_`, which skill names never contain, so scopes can't shadow each other.
 */
export default defineDynamic(async (ctx: DynamicContext) => {
  const scopes = await loadTurnSkills({
    session: ctx.session,
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
    turnId: ctx.turn?.id,
  });
  const entries: Record<string, ReturnType<typeof defineSkill>> = {};
  for (const { scope, skills } of scopes) {
    for (const skill of skills) {
      if (skill.applicationMode === "always") continue;
      const name = loadName(scope, skill.name);
      if (name in entries) continue;
      entries[name] = defineSkill({
        description: skill.description,
        content: skill.instructions,
        deferred: skill.applicationMode === "deferred",
      });
    }
  }
  return Object.keys(entries).length > 0 ? entries : null;
});
