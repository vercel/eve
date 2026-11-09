import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic((ctx) =>
  ctx.turn?.input.some((part) => part.kind === "text" && part.text.includes("[expand-envelope]"))
    ? defineInstructions({
        role: "system",
        content: `EXPANDED_POLICY ${"Use the configured catalog policy. ".repeat(140)}`,
      })
    : null,
);
