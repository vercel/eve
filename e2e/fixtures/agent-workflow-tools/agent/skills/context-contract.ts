import { defineDynamic, defineSkill, type DynamicResolveContext } from "eve/skills";
import { recordDynamicSkillContext } from "../../dynamic-skill-context-audit";

function resolve(event: "session.started" | "turn.started", ctx: DynamicResolveContext) {
  recordDynamicSkillContext(event, ctx);
  return defineSkill({
    description: "Policy for auditing dynamic skill context.",
    markdown: "Read the recorded resolver context when asked to audit it.",
  });
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => resolve("session.started", ctx),
    "turn.started": (_event, ctx) => resolve("turn.started", ctx),
  },
});
