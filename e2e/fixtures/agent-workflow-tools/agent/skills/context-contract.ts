import { defineDynamic, defineSkill } from "eve/skills";
import { recordDynamicSkillContext } from "../../dynamic-skill-context-audit";

export default defineDynamic((ctx) => {
  recordDynamicSkillContext(ctx);
  return defineSkill({
    description: "Policy for auditing dynamic skill context.",
    content: "Read the recorded resolver context when asked to audit it.",
  });
});
