export function formatModelSummary(input: {
  model: string;
  reasoning?: string;
  fastGlyph?: string;
}): string {
  const model = input.model.slice(input.model.lastIndexOf("/") + 1).replace(/-fast$/u, "");
  return [model, input.reasoning, input.fastGlyph]
    .filter((segment) => segment !== undefined)
    .join(" · ");
}
