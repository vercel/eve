import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Session ${ctx.session.id} was started ${ctx.session.auth.initiator === null ? "anonymously" : "by an authenticated user"}.`,
      }),
  },
});
