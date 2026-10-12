import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  // Six seed turns precede expansion.
  select: (view) => view.session.turnCount > 6,
  render: (expanded) =>
    expanded
      ? defineInstructions({
          role: "system",
          content: `EXPANDED_POLICY ${"Use the configured catalog policy. ".repeat(140)}`,
        })
      : null,
});
