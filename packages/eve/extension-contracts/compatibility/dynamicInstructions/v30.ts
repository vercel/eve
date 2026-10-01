import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 30 sessions had no `task.activity` event; epoch 31 adds it.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Wait for your tasks in session ${ctx.session.id} before you reply.`,
      }),
  },
});
