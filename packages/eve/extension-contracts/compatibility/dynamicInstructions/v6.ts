import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Use session ${ctx.session.id} when correlating evidence.`,
      }),
  },
});
