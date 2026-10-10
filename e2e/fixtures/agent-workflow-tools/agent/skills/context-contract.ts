import { defineDynamic, defineSkill } from "eve/skills";
import { recordDynamicSkillContext } from "../../dynamic-skill-context-audit";

export default defineDynamic({
  select: (view) => view.latest["turn.started"] ?? null,
  resolve: (turn, ctx) => {
    recordDynamicSkillContext(turn === null ? "session.started" : "turn.started", ctx);
    return defineSkill({
      description: "Policy for auditing dynamic skill context.",
      markdown: "Read the recorded resolver context when asked to audit it.",
    });
  },
});
