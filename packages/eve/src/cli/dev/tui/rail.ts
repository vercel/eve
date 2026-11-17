import type { Theme } from "./theme.js";

export const TOOL_COLUMN_LEAD = "  ";

export function elisionText(hidden: number, theme: Theme): string {
  return theme.colors.dim(`${theme.glyph.ellipsis} (${hidden} more)`);
}
