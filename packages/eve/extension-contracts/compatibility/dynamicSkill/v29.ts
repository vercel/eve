import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 29 sessions had no `task.activity` event; epoch 30 adds it.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Follow up on running tasks.",
        markdown: `Check on the tasks in session ${ctx.session.id} before you reply.`,
      }),
  },
});
