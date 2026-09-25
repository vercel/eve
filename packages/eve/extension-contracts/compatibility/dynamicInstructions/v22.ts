// Existing callbacks remain valid when the runtime supplies session.context.
import { defineDynamic, defineInstructions } from "#public/instructions/index.js";
export default defineDynamic({
  events: {
    "session.started": (_, ctx) =>
      defineInstructions({
        content: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
