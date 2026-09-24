import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 25 approval events carried no taskId; epoch 26 adds it for approvals
// proxied from a child task. Instruction definitions are unchanged.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Summarize pending approvals for session ${ctx.session.id}.`,
      }),
  },
});
