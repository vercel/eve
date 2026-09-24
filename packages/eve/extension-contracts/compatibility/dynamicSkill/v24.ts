import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 24 approval events carried no taskId; epoch 25 adds it for approvals
// proxied from a child task. Skill definitions are unchanged.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the pending approval queue.",
        markdown: `Review pending approvals for session ${ctx.session.id}.`,
      }),
  },
});
