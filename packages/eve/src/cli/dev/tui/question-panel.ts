/**
 * Pure rendering for the HITL question drawer — a pending question request
 * (such as one from `ask_question` or `ctx.ask()`) opens above the input area.
 * Options render as numbered rows with their
 * descriptions always visible, and the trailing "Type your own answer" row
 * carries an inline elbow editor that receives focus the moment the cursor
 * rests on it (the provider-key grammar from the setup panel). The renderer
 * hosts lifecycle and keys; this module only paints rows.
 */

import type { AgentTUIInputContext, AgentTUIInputOption } from "./runner.js";
import { visibleLine, type LineState } from "./line-editor.js";
import type { Theme } from "./theme.js";
import {
  clipVisible,
  renderInputText,
  renderInputWithBlockCursor,
  stripTerminalControls,
  wrapVisibleLine,
} from "#cli/ui/terminal-text.js";
import { renderOptionRow } from "#setup/cli/option-row.js";

const FREEFORM_ROW_LABEL = "Type your own answer…";

interface QuestionPanelState {
  readonly prompt: string;
  readonly options: readonly AgentTUIInputOption[];
  /** Row index under the cursor; `options.length` is the freeform row. */
  readonly cursor: number;
  /** Whether the trailing freeform row exists. */
  readonly allowFreeform: boolean;
  /** The freeform row's inline editor; focused while the cursor rests on it. */
  readonly editor: LineState;
  readonly caretVisible: boolean;
  readonly maxRows?: number;
}

export function renderQuestionPanel(
  state: QuestionPanelState,
  theme: Theme,
  width: number,
): string[] {
  const rows = renderQuestionPrompt(state.prompt, theme, width);
  rows.push("");
  let focusedRow = rows.length;
  let focusedEndRow = focusedRow;
  for (const [index, option] of state.options.entries()) {
    if (index === state.cursor) focusedRow = rows.length;
    rows.push(
      ...renderQuestionChoice(option, index === state.cursor, theme).flatMap((row) =>
        row.split(/\r?\n/u),
      ),
    );
    if (index === state.cursor) focusedEndRow = rows.length - 1;
  }
  if (state.allowFreeform) {
    if (state.cursor === state.options.length) focusedRow = focusedEndRow = rows.length;
    rows.push(renderFreeformRow(state, theme, width));
  }

  return fitQuestionPanel(
    rows.map((row) => clipVisible(row, width)),
    state.maxRows ?? rows.length,
    focusedRow,
    focusedEndRow,
  );
}

export function renderQuestionPrompt(prompt: string, theme: Theme, width: number): string[] {
  return stripTerminalControls(prompt)
    .split(/\r?\n/u)
    .flatMap((line) => wrapVisibleLine(line, Math.max(1, width - 2)))
    .map((line) => `  ${theme.colors.bold(line)}`);
}

/** Window the body, keeping the focused choice or editor reachable on short terminals. */
export function fitQuestionPanel(
  rows: readonly string[],
  maxRows: number,
  focusedRow = rows.length - 1,
  focusedEndRow = focusedRow,
): string[] {
  // Keep the label when one choice's description is taller than the viewport.
  const end = Math.min(focusedEndRow, focusedRow + maxRows - 1);
  const start = Math.max(0, Math.min(end - maxRows + 1, rows.length - maxRows));
  return rows.slice(start, start + maxRows);
}

/** Who asked for a prompt and where it sits among the open requests, for the drawer's corner. */
export function inputContextLabel(
  context: AgentTUIInputContext | undefined,
  theme: Theme,
): string | undefined {
  const parts: string[] = [];
  if (context?.requester !== undefined) parts.push(stripTerminalControls(context.requester));
  if (context?.position !== undefined) {
    parts.push(`${context.position.index} of ${context.position.total}`);
  }
  return parts.length === 0 ? undefined : parts.join(` ${theme.glyph.dot} `);
}

function renderQuestionChoice(
  option: AgentTUIInputOption,
  isCursor: boolean,
  theme: Theme,
): string[] {
  const row = renderOptionRow({
    colors: theme.colors,
    glyphs: {
      pointer: theme.glyph.pointer,
      selectedPointer: theme.glyph.selectedPointer,
      success: theme.glyph.success,
      placeholder: theme.glyph.option,
      dot: theme.glyph.dot,
      warning: theme.glyph.warning,
    },
    label: option.label,
    isCursor,
    state: { kind: "available", checked: false },
    placeholder: false,
    presentation: "minimal",
  });
  const rows = [`  ${row}`];
  if (option.description !== undefined && option.description.length > 0) {
    rows.push(`     ${theme.colors.dim(option.description)}`);
  }
  return rows;
}

function renderFreeformRow(state: QuestionPanelState, theme: Theme, width: number): string {
  const c = theme.colors;
  const focused = state.cursor === state.options.length;
  // Reserve the block cursor's trailing cell so an input at the width limit
  // never clips its caret.
  const budget = Math.max(4, width - 6);
  if (!focused) {
    const visible = visibleLine(state.editor, budget, theme.glyph.ellipsis);
    const value =
      state.editor.text.length === 0
        ? FREEFORM_ROW_LABEL
        : `${visible.before}${visible.under}${visible.after}`;
    return `     ${c.dim(value)}`;
  }

  const placeholder = state.editor.text.length === 0;
  const line = placeholder ? { text: FREEFORM_ROW_LABEL, cursor: 0 } : state.editor;
  return `     ${renderInputWithBlockCursor({
    ...visibleLine(line, budget, theme.glyph.ellipsis),
    visible: state.caretVisible,
    inverse: c.inverse,
    render: placeholder ? (text) => c.dim(renderInputText(text)) : undefined,
  })}`;
}
