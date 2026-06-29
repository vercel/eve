/**
 * The one option-row painter shared by every picker — the CLI prompts
 * (`prompt-ui.ts`) and the dev TUI flow panel (`setup-panel.ts`). Both surfaces
 * render the same `PromptOption` shape and drive the same `select-state`
 * reducer; this module is the single place the row itself is drawn, so glyphs,
 * state styling, and hint alignment never drift between surfaces again.
 *
 * One glyph column encodes the row's state and the icon changes on hover — the
 * cursor never occupies its own column. Callers supply their own color and
 * glyph primitives (the TUI from its theme, the CLI from picocolors), but the
 * layout and state logic live here.
 */

/** The color primitives the row painter needs; satisfied by both the TUI theme and the CLI palette. */
export interface RowColors {
  blue(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  inverse(text: string): string;
  yellow(text: string): string;
}

/** The glyphs the row painter draws; the TUI passes theme-derived values, the CLI the unicode set. */
export interface RowGlyphs {
  /** Hollow cursor marker for an inert row. */
  pointer: string;
  /** Filled cursor marker for an actionable row. */
  selectedPointer: string;
  /** Completed / checked marker. */
  success: string;
  /** Available, un-hovered marker. */
  placeholder: string;
  /** Separator before an inline hint. */
  dot: string;
  /** Attention marker for an unavailable option with actionable guidance. */
  warning: string;
}

/** Canonical unicode glyphs; the CLI prompts render with these. */
export const UNICODE_ROW_GLYPHS: RowGlyphs = {
  pointer: "▷",
  selectedPointer: "▶",
  success: "✓",
  placeholder: "◦",
  dot: "·",
  warning: "⚠",
};

export type OptionRowState =
  | { kind: "available"; checked: boolean }
  | { kind: "completed" }
  | { kind: "disabled"; reason?: string; reasonTone?: "warning" }
  | { kind: "locked"; reason?: string };

interface OptionRowInput {
  colors: RowColors;
  glyphs: RowGlyphs;
  label: string;
  /** Inline annotation shown whenever the row is in view. */
  hint?: string;
  /** Inline annotation shown only while the cursor is on this row. */
  focusHint?: string;
  isCursor: boolean;
  state: OptionRowState;
  /** Whether an un-hovered, selectable row draws the placeholder glyph. */
  placeholder: boolean;
  /** Spaces inserted before the hint's dot so hints tab-align to a shared column. */
  hintPadding?: number;
  /**
   * Accent for an available row. "warning" keeps an attention row yellow at
   * rest and under the cursor highlight.
   */
  accent?: "warning";
}

/**
 * Resolves legacy option flags into one render state. The public prompt shape
 * remains ergonomic for callers, while contradictory row semantics fail at
 * this boundary instead of producing a glyph from one flag and a label from
 * another.
 */
export function resolveOptionRowState(
  option: {
    disabled?: boolean;
    disabledReason?: string;
    disabledReasonTone?: "warning";
    completed?: boolean;
    locked?: boolean;
    lockedReason?: string;
  },
  checked: boolean,
): OptionRowState {
  const semanticStateCount =
    Number(option.disabled === true) +
    Number(option.completed === true) +
    Number(option.locked === true);
  if (semanticStateCount > 1) {
    throw new Error("An option row cannot combine disabled, completed, or locked states.");
  }
  if (option.disabled === true) {
    const state: Extract<OptionRowState, { kind: "disabled" }> = { kind: "disabled" };
    if (option.disabledReason !== undefined) state.reason = option.disabledReason;
    if (option.disabledReasonTone !== undefined) state.reasonTone = option.disabledReasonTone;
    return state;
  }
  if (option.completed === true) return { kind: "completed" };
  if (option.locked === true) {
    const state: Extract<OptionRowState, { kind: "locked" }> = { kind: "locked" };
    if (option.lockedReason !== undefined) state.reason = option.lockedReason;
    return state;
  }
  return { kind: "available", checked };
}

interface OptionRowPresentation {
  glyph: string;
  label: string;
}

function parenthetical(reason: string | undefined): string {
  return reason === undefined ? "" : ` (${reason})`;
}

function unfocusedGlyph(input: OptionRowInput): string {
  return input.placeholder ? input.colors.dim(input.glyphs.placeholder) : " ";
}

function disabledLabel(
  label: string,
  state: Extract<OptionRowState, { kind: "disabled" }>,
  colors: RowColors,
  glyphs: RowGlyphs,
): string {
  if (state.reasonTone === "warning") {
    const warning = state.reason === undefined ? "" : ` ${glyphs.warning} ${state.reason}`;
    return `${colors.dim(label)}${colors.yellow(warning)}`;
  }
  const reason = parenthetical(state.reason);
  return colors.dim(`${label}${reason}`);
}

function optionRowPresentation(input: OptionRowInput): OptionRowPresentation {
  const { colors: c, glyphs, state } = input;

  switch (state.kind) {
    case "available":
      if (input.isCursor) {
        return {
          glyph: glyphs.selectedPointer,
          label: input.label,
        };
      }
      return {
        glyph: state.checked ? c.green(glyphs.success) : unfocusedGlyph(input),
        label: input.accent === "warning" ? c.yellow(input.label) : input.label,
      };
    case "completed":
      return {
        glyph: input.isCursor ? c.dim(glyphs.pointer) : c.green(glyphs.success),
        label: c.dim(input.label),
      };
    case "disabled":
      return {
        glyph: input.isCursor ? c.dim(glyphs.pointer) : unfocusedGlyph(input),
        label: disabledLabel(input.label, state, c, glyphs),
      };
    case "locked":
      return {
        glyph: c.dim(c.green(glyphs.success)),
        label: c.dim(`${input.label}${parenthetical(state.reason)}`),
      };
  }

  const exhaustive: never = state;
  return exhaustive;
}

/** Paints a row with the shared leading cell and optional cursor highlight. */
export function renderCursorRow(
  text: string,
  selected: boolean,
  colors: Pick<RowColors, "blue" | "inverse" | "yellow">,
  accent?: "warning",
): string {
  if (!selected) return ` ${text}`;
  const color = accent === "warning" ? colors.yellow : colors.blue;
  return colors.inverse(color(` ${text} `));
}

/** Prefixes a continuation line so its text starts in the option label column. */
export function renderOptionRowContinuation(text: string): string {
  return `   ${text}`;
}

/**
 * Paints one option row as `glyph label · hint`. The glyph reflects state with
 * hover taking precedence for focusable rows: available rows use the active
 * pointer, completed and disabled rows use an inert pointer, and locked rows
 * retain their mandatory-selection check. The hint rides the same dot-aligned
 * column for every row, whether it is persistent or cursor-only.
 */
export function renderOptionRow(input: OptionRowInput): string {
  const { colors: c, glyphs } = input;
  const { glyph, label } = optionRowPresentation(input);
  const selected = input.isCursor && input.state.kind === "available";

  let hintText = input.hint;
  if (input.isCursor && input.focusHint !== undefined) hintText = input.focusHint;
  let hint = "";
  if (hintText !== undefined) {
    const separatorWidth = Math.max(0, (input.hintPadding ?? 0) + 1 - Number(selected));
    hint = c.dim(`${" ".repeat(separatorWidth)}${glyphs.dot} ${hintText}`);
  }
  const content = `${glyph} ${label}`;
  const row = renderCursorRow(content, selected, c, input.accent);
  return `${row}${hint}`;
}
