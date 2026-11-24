import { defineDynamic, defineSkill, type SkillDefinition } from "eve/skills";

import { deserializeSkill, isValidRepositorySkillName, repoState } from "../lib/repo-state.ts";

export default defineDynamic(() => {
  const state = repoState.get();
  const skills: Record<string, SkillDefinition> = {};
  for (const repo of Object.values(state.byRoot)) {
    for (const [name, serialized] of Object.entries(repo.ruleSkills)) {
      if (!isValidRepositorySkillName(name)) continue;
      if (name in skills) continue;
      skills[name] = defineSkill(deserializeSkill(serialized));
    }
  }
  return Object.keys(skills).length === 0 ? null : skills;
});
