/** Compact display label for the dev TUI: `model · reasoning · ⚡︎`. */
export function formatModelSummary(input: {
  model: string;
  /** Authored reasoning level; omitted renders the bare slug. */
  reasoning?: string;
  /** Speed marker glyph, present for intrinsic speed or the priority tier. */
  fastGlyph?: string;
}): string {
  const model = input.model.slice(input.model.lastIndexOf("/") + 1).replace(/-fast$/u, "");
  return [model, input.reasoning, input.fastGlyph]
    .filter((segment) => segment !== undefined)
    .join(" · ");
}
