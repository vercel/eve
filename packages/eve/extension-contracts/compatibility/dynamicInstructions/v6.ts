import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Prefer cached evidence when replying in session ${ctx.session.id}.`,
      }),
  },
});
