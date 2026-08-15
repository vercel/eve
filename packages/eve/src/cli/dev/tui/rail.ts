/**
 * The shared atoms of the transcript's rail grammar. Persistent sections
 * (tool rows, subagent sections, the todo panel) all hang their marks at the
 * same two-cell tool column and elide overflow with the same counted row —
 * one definition keeps the alignment a checked fact instead of a set of
 * parallel comments.
 */

import type { Theme } from "./theme.js";

/**
 * The two-cell indent that puts a section's mark at the prose text column
 * (the character after the `│`/`▲` gutter marks).
 */
export const TOOL_COLUMN_LEAD = "  ";

/** The dim `… (N more)` elision label used by every capped region. */
export function elisionText(hidden: number, theme: Theme): string {
  return theme.colors.dim(`${theme.glyph.ellipsis} (${hidden} more)`);
}
