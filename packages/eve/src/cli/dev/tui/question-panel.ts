/**
 * Pure rendering for the HITL question panel — the overlay the agent's
 * `ask_question` tool opens above the input area. A full-width rule separates
 * it from the transcript, options render as numbered rows with their
 * descriptions always visible, and the trailing "Type your own answer" row
 * carries an inline elbow editor that receives focus the moment the cursor
 * rests on it (the provider-key grammar from the setup panel). The renderer
 * hosts lifecycle and keys; this module only paints rows.
 */

import type { AgentTUIInputOption } from "./runner.js";
import { visibleLine, type LineState } from "./line-editor.js";
import type { Theme } from "./theme.js";
import { clipVisible, renderInputWithBlockCursor, wrapVisibleLine } from "#cli/ui/terminal-text.js";

const FREEFORM_ROW_LABEL = "Type your own answer";

export interface QuestionPanelState {
  readonly prompt: string;
  readonly options: readonly AgentTUIInputOption[];
  /** Row index under the cursor; `options.length` is the freeform row. */
  readonly cursor: number;
  /** Whether the trailing freeform row exists. */
  readonly allowFreeform: boolean;
  /** The freeform row's inline editor; focused while the cursor rests on it. */
  readonly editor: LineState;
  readonly caretVisible: boolean;
}

/** Rows under the cursor paint like the setup panel's selected option. */
function selectedRow(text: string, theme: Theme): string {
  const c = theme.colors;
  return `${c.inverse(c.blue(` ${theme.glyph.selectedPointer} ${text} `))} ${c.dim("↵")}`;
}

export function renderQuestionPanel(
  state: QuestionPanelState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const g = theme.glyph;
  // The rule hugs the question — no blank row between them.
  const rows: string[] = [c.dim(g.hrule.repeat(Math.max(1, width)))];

  // The prompt is model-authored and can span paragraphs. Embedded newlines
  // MUST split before width-wrapping: a row that secretly holds newlines
  // occupies more terminal rows than the live region accounts for, leaking a
  // duplicate frame into scrollback on every repaint.
  for (const logical of state.prompt.split(/\r?\n/u)) {
    for (const line of wrapVisibleLine(logical, Math.max(8, width - 2))) {
      rows.push(`  ${c.bold(line)}`);
    }
  }
  rows.push("");

  for (const [index, option] of state.options.entries()) {
    rows.push(...optionRows(option.label, option.description, index, state, theme));
  }
  if (state.allowFreeform) {
    const index = state.options.length;
    const focused = state.cursor === index;
    rows.push(...optionRows(FREEFORM_ROW_LABEL, undefined, index, state, theme));
    if (focused || state.editor.text.length > 0) {
      rows.push(`        ${c.dim(g.elbow)} ${freeformEditorBody(state, focused, theme, width)}`);
    }
  }

  // One quiet hint; arrow/enter affordances are carried by the cursor row
  // itself. The overlay suppresses the footer's status hint row entirely.
  rows.push("", `  ${c.dim("Esc to dismiss")}`);
  return rows.map((row) => clipVisible(row, width));
}

function optionRows(
  label: string,
  description: string | undefined,
  index: number,
  state: QuestionPanelState,
  theme: Theme,
): string[] {
  const c = theme.colors;
  const numbered = `${index + 1}. ${label}`;
  // Both variants put the number at column 5 and the label at column 8 —
  // the selected row's extra cells are its pointer and padding, so moving
  // the cursor never shifts the text horizontally.
  const rows = [
    state.cursor === index
      ? `  ${selectedRow(numbered, theme)}`
      : `     ${c.dim(`${index + 1}.`)} ${label}`,
  ];
  if (description !== undefined && description.length > 0) {
    rows.push(`        ${c.dim(description)}`);
  }
  return rows;
}

function freeformEditorBody(
  state: QuestionPanelState,
  focused: boolean,
  theme: Theme,
  width: number,
): string {
  const c = theme.colors;
  // Reserve the elbow gutter plus the block cursor's trailing cell.
  const budget = Math.max(4, width - 12);
  if (!focused) {
    const preserved = visibleLine(state.editor, budget, theme.glyph.ellipsis);
    return c.dim(`${preserved.before}${preserved.under}${preserved.after}`);
  }
  return renderInputWithBlockCursor({
    ...visibleLine(state.editor, budget, theme.glyph.ellipsis),
    visible: state.caretVisible,
    inverse: c.inverse,
  });
}
