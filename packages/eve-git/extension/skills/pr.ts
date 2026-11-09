import { defineDynamic, defineSkill } from "eve/skills";

import extension from "../extension.ts";
import { prSkillDescription, prSkillMarkdown } from "../lib/github-guidance.ts";

export default defineDynamic(() => {
  const github = extension.config.github !== undefined;
  return defineSkill({
    description: prSkillDescription(github),
    content: prSkillMarkdown(github),
  });
});
