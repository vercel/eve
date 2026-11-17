import { defineDynamic, defineSkill, type DynamicContext } from "eve/skills";

import { loadTurnSkills } from "../lib/runtime.ts";
import { loadName } from "../lib/tool-support.ts";

export default defineDynamic(async (ctx: DynamicContext) => {
  const scopes = await loadTurnSkills({
    session: ctx.session,
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
    turnId: ctx.turn?.id,
  });
  const entries: Record<string, ReturnType<typeof defineSkill>> = Object.create(null);
  for (const { scope, skills } of scopes) {
    for (const skill of skills) {
      if (skill.applicationMode === "always") continue;
      const name = loadName(scope, skill.name);
      if (Object.hasOwn(entries, name)) continue;
      entries[name] = defineSkill({
        description: skill.description,
        content: skill.instructions,
        deferred: skill.applicationMode === "deferred",
      });
    }
  }
  return Object.keys(entries).length > 0 ? { ...entries } : null;
});
