import { ContextKey } from "#context/key.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";

export const AuthoredSkillsKey = new ContextKey<readonly ResolvedSkillDefinition[]>(
  "eve.authoredSkills",
);
