import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!JSON.stringify(ctx.messages).includes("[expand-envelope]")) return null;
      return defineInstructions({
        role: "system",
        content: `EXPANDED_POLICY ${"Use the configured catalog policy. ".repeat(140)}`,
      });
    },
  },
});
