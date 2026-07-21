import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": (event, ctx) => {
      void event;
      return defineInstructions({
        markdown: `You are assisting session ${ctx.session.id}.`,
      });
    },
  },
});
