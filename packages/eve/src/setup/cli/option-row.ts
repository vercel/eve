export interface RowColors {
  blue(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  inverse(text: string): string;
  yellow(text: string): string;
}

interface RowGlyphs {
  pointer: string;
  selectedPointer: string;
  success: string;
  placeholder: string;
  dot: string;
  warning: string;
}

export const UNICODE_ROW_GLYPHS: RowGlyphs = {
  pointer: "›",
  selectedPointer: "›",
  success: "✓",
  placeholder: " ",
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
  hint?: string;
  focusHint?: string;
  isCursor: boolean;
  state: OptionRowState;
  placeholder: boolean;
  presentation?: "cursor" | "minimal";
  hintPadding?: number;
  accent?: "warning";
}

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
          glyph: state.checked ? glyphs.success : glyphs.selectedPointer,
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

export function renderCursorRow(
  text: string,
  selected: boolean,
  colors: Pick<RowColors, "blue" | "inverse" | "yellow" | "bold">,
  accent?: "warning",
): string {
  if (!selected) return ` ${text}`;
  const color = accent === "warning" ? colors.yellow : colors.bold;
  return color(` ${text}`);
}

export function renderOptionRowContinuation(text: string): string {
  return `   ${text}`;
}

export function renderOptionRow(input: OptionRowInput): string {
  const { colors: c, glyphs } = input;
  const { glyph, label } = optionRowPresentation(input);
  const selected = input.isCursor && input.state.kind === "available";

  let hintText = input.hint;
  if (input.isCursor && input.focusHint !== undefined) hintText = input.focusHint;
  let hint = "";
  if (hintText !== undefined) {
    const separatorWidth = Math.max(0, (input.hintPadding ?? 0) + 1);
    hint = c.dim(`${" ".repeat(separatorWidth)}${glyphs.dot} ${hintText}`);
  }
  if (input.presentation === "minimal") {
    const styledLabel =
      input.state.kind === "available" ? (selected ? c.bold(label) : c.dim(label)) : label;
    const marker =
      (input.state.kind === "available" && !input.state.checked) ||
      (input.state.kind === "disabled" && !input.isCursor)
        ? " "
        : glyph;
    return ` ${marker} ${styledLabel}${hint}`;
  }
  const content = `${glyph} ${label}`;
  const row = renderCursorRow(content, selected, c, input.accent);
  return `${row}${hint}`;
}
