/**
 * Pure rendering for the HITL question drawer — a pending question request
 * (such as one from `ask_question` or `ctx.ask()`) opens above the input area.
 * Options render as numbered rows with their
 * descriptions always visible, and the trailing "Type your own answer" row
 * carries an inline elbow editor that receives focus the moment the cursor
 * rests on it (the provider-key grammar from the setup panel). The renderer
 * hosts lifecycle and keys; this module only paints rows.
 */

import type { AgentTUIInputOption } from "./runner.js";
import { visibleLine, type LineState } from "./line-editor.js";
import type { Theme } from "./theme.js";
import { clipVisible, renderInputWithBlockCursor, wrapVisibleLine } from "#cli/ui/terminal-text.js";
import { renderOptionRow } from "#setup/cli/option-row.js";

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

export function renderQuestionPanel(
  state: QuestionPanelState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const g = theme.glyph;
  // The rule hugs the question — no blank row between them.
  const rows: string[] = [];

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

  rows.push(...renderQuestionChoices(state.options, state.cursor, theme));
  if (state.allowFreeform) {
    const index = state.options.length;
    const focused = state.cursor === index;
    rows.push(
      ...renderQuestionChoices([{ id: "freeform", label: FREEFORM_ROW_LABEL }], 0, theme, focused),
    );
    if (focused || state.editor.text.length > 0) {
      rows.push(`        ${c.dim(g.elbow)} ${freeformEditorBody(state, focused, theme, width)}`);
    }
  }

  return rows.map((row) => clipVisible(row, width));
}

export function renderQuestionChoices(
  options: readonly AgentTUIInputOption[],
  cursor: number,
  theme: Theme,
  forceCursor = false,
): string[] {
  return options.flatMap((option, index) => {
    const isCursor = forceCursor || cursor === index;
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
  });
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
