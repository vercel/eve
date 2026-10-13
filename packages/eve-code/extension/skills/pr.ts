import { prSkillDescription, prSkillMarkdown } from "eve/extensions/git/sandbox";
import { defineDynamic, defineSkill, once } from "eve/skills";

import { deprecatedGitHubConfigured } from "../lib/github-compat.ts";

/** @deprecated Mount `eve/extensions/git`, which contributes the same skill as `git__pr`. */
export default defineDynamic({
  select: once,
  render: () =>
    deprecatedGitHubConfigured()
      ? defineSkill({ description: prSkillDescription(true), markdown: prSkillMarkdown(true) })
      : null,
});
