// Existing callbacks remain valid when message.received carries clientContext.
import { defineDynamic, defineInstructions } from "#public/instructions/index.js";
export default defineDynamic({
  events: {
    "session.started": (_, ctx) =>
      defineInstructions({
        content: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
