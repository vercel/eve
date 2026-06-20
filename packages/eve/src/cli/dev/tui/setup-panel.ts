/**
 * Pure rendering for the bordered setup flow panel — the input-region variant
 * a setup command runs inside for its whole duration (the Claude Code
 * `/model`-panel grammar): a full-width rule, the command as a blue title,
 * the flow's recent progress lines, and the active question (numbered option
 * rows or a text field) or the ephemeral status spinner. Behavior state comes
 * from the shared select reducer (`#setup/cli/select-state.js`); this module
 * only paints rows, so the renderer hosts lifecycle and keys while tests
 * assert on strings.
 *
 * Column grammar: the panel adds a one-space left margin to every row under
 * the rule, while each section contributes two more spaces. Titles, spinners,
 * notices, filter prompts, and option-state glyphs therefore all begin at
 * column 3.
 */

import type { ChannelSetupAction, PromptOption } from "#setup/cli/index.js";
import { renderOptionRow, resolveOptionRowState } from "#setup/cli/option-row.js";
import { filterOptions, submitRowIndex, type SelectState } from "#setup/cli/select-state.js";
import type { SelectNotice } from "#setup/prompter.js";
import { graphemes } from "#shared/text-boundaries.js";

import { visibleLine, type LineState } from "./line-editor.js";
import type { Theme } from "./theme.js";
import { clipVisible, renderInputText, visibleLength, wrapVisibleLine } from "./terminal-text.js";

function clip(line: string, width: number): string {
  return clipVisible(line, width);
}

/** One row of a setup select panel; the shared prompt-option shape. */
export type SetupPanelOption = PromptOption<string>;

interface SetupQuestionPanelBase {
  message: string;
  error?: string;
  /** Outcome lines from earlier menu laps, shown beneath the options. */
  notices?: readonly SelectNotice[];
}

interface SetupSelectPanelBase extends SetupQuestionPanelBase {
  options: readonly SetupPanelOption[];
  select: SelectState;
}

interface SetupEditableRow {
  /**
   * The row whose hint is a live rename field. Hovering it (cursor on the row)
   * makes it editable directly — typing and backspace edit the name in place —
   * so the editor's text and a blinking caret render only on that row.
   */
  optionValue: string;
  editor: LineState;
  defaultValue: string;
  formatHint: (value: string) => string;
  caretVisible: boolean;
}

/**
 * Select presentation variants. The discriminant owns the interaction grammar
 * so feature combinations are deliberate rather than resolved by conditional
 * precedence inside the renderer.
 */
type SetupOptionSelectPanelState =
  | (SetupSelectPanelBase & { kind: "single" })
  | (SetupSelectPanelBase & { kind: "search"; placeholder?: string })
  | (SetupSelectPanelBase & { kind: "multi" })
  | (SetupSelectPanelBase & { kind: "searchable-multi"; placeholder?: string })
  | (SetupSelectPanelBase & { kind: "stacked" })
  | (SetupSelectPanelBase & { kind: "task-list" })
  | (SetupSelectPanelBase & { kind: "editable"; edit: SetupEditableRow });

interface SetupActionsPanelState {
  kind: "actions";
  /** Inert explanation rendered above, and separately from, the action group. */
  context: string;
  actions: readonly ChannelSetupAction[];
  /** No action is focused until the user moves into the action group. */
  cursor: number | undefined;
}

export type SetupSelectPanelState = SetupOptionSelectPanelState | SetupActionsPanelState;

export interface SetupTextPanelState {
  message: string;
  editor: LineState;
  placeholder?: string;
  mask: boolean;
  error?: string;
  /** Context lines shown above the message; gone once the question settles. */
  notices?: readonly SelectNotice[];
}

export interface SetupAcknowledgePanelState {
  message: string;
  lines: readonly string[];
}

/** One progress line shown inside the flow panel while it runs. */
export interface FlowPanelLine {
  text: string;
  tone: "info" | "success" | "warning" | "error";
  /**
   * Subprocess output a warning/error settle pulled in as its evidence.
   * Renders like any info line in the panel, but survives the panel close
   * alongside the diagnostic it explains (a plain info line does not).
   */
  evidence?: boolean;
}

export type FlowPanelContent =
  | {
      kind: "question";
      rows: readonly string[];
      /** The install wait keeps its spinner above the concurrent actions. */
      status?: { text: string; frame: string };
    }
  | {
      kind: "status";
      status: { text: string; frame: string };
      /** Latest child-process output shown transiently beneath the status. */
      preview?: string;
    }
  | { kind: "preview"; text: string; frame: string }
  | { kind: "idle"; frame: string };

/** The whole bordered section: title, recent progress, and one explicit mode. */
export interface FlowPanelState {
  /** The invoked command, e.g. "/deploy". Empty renders no title row. */
  title: string;
  lines: readonly FlowPanelLine[];
  content: FlowPanelContent;
}

/** How many option rows a searchable panel shows before windowing. */
const SEARCH_VIEW_SIZE = 8;

/** The flow panel keeps only the freshest progress in view. */
const FLOW_PANEL_LINE_CAP = 6;

function questionFooter(hints: readonly string[], theme: Theme): string[] {
  const c = theme.colors;
  return ["", `  ${c.dim(c.italic(hints.join(` ${theme.glyph.dot} `)))}`];
}

const BOLD_OR_DIM_CLOSE = "\x1b[22m";
const DIM_OPEN = "\x1b[2m";

/**
 * Dims a line that may carry embedded bold spans (e.g. a flow bolding a
 * project name inside a hint): SGR 22 closes bold AND dim together, so dim is
 * re-opened after each close or the line's tail would render full-bright.
 */
function dimWithEmphasis(text: string, theme: Theme): string {
  return theme.colors.dim(text.replaceAll(BOLD_OR_DIM_CLOSE, `${BOLD_OR_DIM_CLOSE}${DIM_OPEN}`));
}

function toneGlyph(tone: FlowPanelLine["tone"], theme: Theme): string {
  const c = theme.colors;
  switch (tone) {
    case "success":
      return c.green(theme.glyph.success);
    case "warning":
      return c.yellow(theme.glyph.warning);
    case "error":
      return c.red(theme.glyph.error);
    case "info":
      return c.dim(theme.glyph.dot);
  }
}

/**
 * Paints the bordered flow panel. Everything a running command produces lives
 * here — progress, questions, the status spinner — and the panel vanishes
 * wholesale when the command resolves; only the command echo and the elbow
 * outcome persist in the transcript.
 */
export function renderFlowPanel(state: FlowPanelState, theme: Theme, width: number): string[] {
  const c = theme.colors;
  const rows: string[] = [c.dim(theme.glyph.hrule.repeat(Math.max(1, width)))];
  if (state.title.length > 0) {
    rows.push(`  ${c.bold(state.title)}`);
  }
  rows.push("");

  const recent = state.lines.slice(-FLOW_PANEL_LINE_CAP);
  for (const line of recent) {
    const body = line.tone === "info" ? c.dim(line.text) : line.text;
    rows.push(`  ${toneGlyph(line.tone, theme)} ${body}`);
  }
  if (recent.length > 0) {
    rows.push("");
  }

  switch (state.content.kind) {
    case "question":
      // The install wait's question rides beneath its live status spinner.
      if (state.content.status !== undefined) {
        rows.push(
          `  ${c.yellow(state.content.status.frame)} ${c.dim(state.content.status.text)}`,
          "",
        );
      }
      rows.push(...state.content.rows);
      break;
    case "status":
      rows.push(`  ${c.yellow(state.content.status.frame)} ${c.dim(state.content.status.text)}`);
      if (state.content.preview !== undefined) {
        rows.push(`    ${c.dim(state.content.preview)}`);
      }
      break;
    case "preview":
      rows.push(`  ${c.yellow(state.content.frame)} ${c.dim(state.content.text)}`);
      break;
    case "idle":
      // A flow between phases must never look dead: boxes run subprocesses
      // without narrating every gap, so the panel keeps a live pulse.
      rows.push(`  ${c.yellow(state.content.frame)} ${c.dim("Working…")}`);
      break;
  }

  // One breathable left margin for everything under the rule; blank rows
  // stay empty so spacing assertions and trailing-whitespace trims hold.
  return rows.map((row, index) =>
    index === 0 || row.length === 0 ? clip(row, width) : clip(` ${row}`, width),
  );
}

function optionRow(input: {
  option: SetupPanelOption;
  isCursor: boolean;
  isChecked: boolean;
  placeholder: boolean;
  hintPadding?: number;
  theme: Theme;
}): string {
  const { option, theme } = input;
  return renderOptionRow({
    colors: theme.colors,
    glyphs: {
      pointer: theme.glyph.pointer,
      success: theme.glyph.success,
      placeholder: theme.glyph.option,
      dot: theme.glyph.dot,
    },
    label: option.label,
    hint: option.hint,
    focusHint: option.focusHint,
    accent: option.accent,
    isCursor: input.isCursor,
    state: resolveOptionRowState(option, input.isChecked),
    placeholder: input.placeholder,
    hintPadding: input.hintPadding,
  });
}

type SelectLayout = "plain" | "stacked" | "task-list";

interface SelectPresentation {
  selection: "single" | "multiple";
  filter: { placeholder: string | undefined } | undefined;
  layout: SelectLayout;
  edit: SetupEditableRow | undefined;
}

function selectPresentation(state: SetupOptionSelectPanelState): SelectPresentation {
  switch (state.kind) {
    case "single":
      return {
        selection: "single",
        filter: undefined,
        layout: "plain",
        edit: undefined,
      };
    case "search":
      return {
        selection: "single",
        filter: { placeholder: state.placeholder },
        layout: "plain",
        edit: undefined,
      };
    case "multi":
      return {
        selection: "multiple",
        filter: undefined,
        layout: "plain",
        edit: undefined,
      };
    case "searchable-multi":
      return {
        selection: "multiple",
        filter: { placeholder: state.placeholder },
        layout: "plain",
        edit: undefined,
      };
    case "stacked":
      return {
        selection: "single",
        filter: undefined,
        layout: "stacked",
        edit: undefined,
      };
    case "task-list":
      return {
        selection: "single",
        filter: undefined,
        layout: "task-list",
        edit: undefined,
      };
    case "editable":
      return {
        selection: "single",
        filter: undefined,
        layout: "task-list",
        edit: state.edit,
      };
  }
}

function selectMessageRows(message: string, layout: SelectLayout, theme: Theme): string[] {
  if (message === "") return [];

  const rows = message.split("\n").map((line, index) => {
    const emphasized = layout === "stacked" || index > 0;
    return `  ${emphasized ? theme.colors.bold(line) : line}`;
  });
  rows.push("");
  return rows;
}

function searchFilter(filter: string, placeholder: string | undefined, theme: Theme): string {
  if (filter.length > 0) return filter + theme.colors.dim(theme.glyph.caret);
  if (placeholder !== undefined) return theme.colors.dim(`> ${placeholder}`);
  return theme.colors.dim(theme.glyph.caret);
}

function selectViewSize(input: {
  search: boolean;
  filter: string;
  featuredLead: number;
  optionCount: number;
}): number {
  if (!input.search) return input.optionCount;
  if (input.filter === "" && input.featuredLead > 0) {
    return Math.min(input.featuredLead, SEARCH_VIEW_SIZE);
  }
  return SEARCH_VIEW_SIZE;
}

function noticeBody(notice: SelectNotice, layout: SelectLayout, theme: Theme): string {
  if (notice.tone === "info") return theme.colors.dim(notice.text);
  if (notice.tone === "success" && layout === "task-list") {
    return theme.colors.bold(notice.text);
  }
  return notice.text;
}

function editableOption(
  option: SetupPanelOption,
  isCursor: boolean,
  edit: SetupEditableRow | undefined,
  theme: Theme,
): SetupPanelOption {
  if (!isCursor || edit?.optionValue !== option.value) return option;

  const value = edit.editor.text || edit.defaultValue;
  const caretAt = edit.editor.text.length === 0 ? value.length : edit.editor.cursor;
  const caret = edit.caretVisible ? theme.colors.cyan(theme.glyph.caret) : "";
  const editableValue = `${value.slice(0, caretAt)}${caret}${value.slice(caretAt)}`;
  return { ...option, hint: edit.formatHint(editableValue) };
}

function optionWithoutStackedHint(
  option: SetupPanelOption,
  layout: SelectLayout,
): { option: SetupPanelOption; stackedHint: string | undefined } {
  if (layout !== "stacked" || option.hint === undefined) {
    return { option, stackedHint: undefined };
  }
  const { hint, ...rest } = option;
  return { option: rest, stackedHint: hint };
}

function optionUsesPlaceholder(
  presentation: SelectPresentation,
  index: number,
  optionCount: number,
): boolean {
  // A type-ahead list draws no placeholder dots — the filter row leads instead.
  const isFiltered = presentation.filter !== undefined;
  // The task list's trailing action (Done) reads as a button, not an option.
  const isTrailingTaskAction = presentation.layout === "task-list" && index === optionCount - 1;
  // Checklists and the explicit menu layouts (stacked, task-list) present every
  // row as a pickable option, so each carries the placeholder dot.
  const isMultiSelect = presentation.selection === "multiple";
  const isMenuLayout = presentation.layout !== "plain";

  return !isFiltered && !isTrailingTaskAction && (isMultiSelect || isMenuLayout);
}

function appendSelectOptionRows(input: {
  rows: string[];
  state: SetupOptionSelectPanelState;
  presentation: SelectPresentation;
  visible: readonly SetupPanelOption[];
  start: number;
  end: number;
  cursor: number;
  visibleLabelWidth: number;
  theme: Theme;
}): void {
  const { rows, state, presentation, visible, start, end, cursor, visibleLabelWidth, theme } =
    input;
  const c = theme.colors;

  for (let index = start; index < end; index += 1) {
    const option = visible[index]!;
    const isCursor = index === cursor;
    if (presentation.layout === "task-list" && index === end - 1 && index > start) {
      rows.push("");
    }

    const rendered = editableOption(option, isCursor, presentation.edit, theme);
    const { option: rowOption, stackedHint } = optionWithoutStackedHint(
      rendered,
      presentation.layout,
    );
    rows.push(
      `  ${optionRow({
        option: rowOption,
        isCursor,
        isChecked: presentation.selection === "multiple" && state.select.selected.has(option.value),
        placeholder: optionUsesPlaceholder(presentation, index, visible.length),
        hintPadding: visibleLabelWidth - option.label.length,
        theme,
      })}`,
    );

    if (stackedHint !== undefined) {
      rows.push(`${" ".repeat(4)}${dimWithEmphasis(stackedHint, theme)}`);
    }
    // Disabled descriptions explain why an inert row cannot be selected, so
    // keep them visible even though the cursor skips that row.
    if (option.description !== undefined && (option.disabled === true || isCursor)) {
      rows.push(`    ${c.dim(option.description)}`);
    }
    if (presentation.layout === "stacked" && index < end - 1) rows.push("");
  }
}

function appendSubmitRow(rows: string[], cursor: number, submitIndex: number, theme: Theme): void {
  if (submitIndex < 0) return;
  const onSubmit = cursor === submitIndex;
  const pointer = onSubmit ? theme.colors.cyan(theme.glyph.pointer) : " ";
  const label = onSubmit ? theme.colors.cyan(theme.colors.bold("Submit")) : "Submit";
  rows.push("", `  ${pointer} ${label}`);
}

function appendSelectNotices(
  rows: string[],
  notices: readonly SelectNotice[] | undefined,
  layout: SelectLayout,
  theme: Theme,
  width: number,
): void {
  if (notices === undefined || notices.length === 0) return;
  rows.push("");
  for (const notice of notices) {
    // Notices sit inside the option grid (column 2), not the panel gutter —
    // a column-0 glyph would jut out of the list it annotates. Continuation
    // lines hang under the notice text rather than under its glyph.
    const glyph = toneGlyph(notice.tone, theme);
    const hangingIndent = " ".repeat(visibleLength(glyph) + 1);
    const textWidth = Math.max(1, width - 2 - visibleLength(glyph) - 1);
    const wrapped = wrapVisibleLine(notice.text, textWidth);
    for (const [index, line] of wrapped.entries()) {
      const body = noticeBody({ ...notice, text: line }, layout, theme);
      rows.push(index === 0 ? `  ${glyph} ${body}` : `  ${hangingIndent}${body}`);
    }
  }
}

function selectFooterHints(
  presentation: SelectPresentation,
  visible: readonly SetupPanelOption[],
  cursor: number,
): string[] {
  const hints: string[] = [];
  if (presentation.edit !== undefined && visible[cursor]?.value === presentation.edit.optionValue) {
    hints.push("type to rename");
  }
  if (presentation.filter !== undefined) hints.push("type to filter");
  hints.push("↑/↓ move");
  hints.push(presentation.selection === "multiple" ? "space to toggle" : "enter to select");
  if (presentation.selection === "multiple") hints.push("enter on Submit to confirm");
  hints.push("esc to cancel");
  return hints;
}

function renderActionQuestion(
  state: SetupActionsPanelState,
  theme: Theme,
  width: number,
): string[] {
  const rows = [`  ${theme.colors.dim(`${theme.glyph.dot} ${state.context}`)}`, ""];

  for (const [index, action] of state.actions.entries()) {
    rows.push(
      `  ${optionRow({
        option: action,
        isCursor: index === state.cursor,
        isChecked: false,
        placeholder: true,
        hintPadding: 0,
        theme,
      })}`,
    );
  }

  rows.push(...questionFooter(["↑/↓ move", "enter to select", "esc to cancel"], theme));
  return rows.map((row) => clip(row, width));
}

/**
 * Paints a selection section for the flow panel. Ordinary selects use the
 * shared option reducer; concurrent actions render an explicit context row and
 * independent action group. A searchable select windows the option list around
 * the cursor and advertises the rest with a count footer.
 */
export function renderSelectQuestion(
  state: SetupSelectPanelState,
  theme: Theme,
  width: number,
): string[] {
  if (state.kind === "actions") return renderActionQuestion(state, theme, width);

  const c = theme.colors;
  const presentation = selectPresentation(state);
  const visible = presentation.filter
    ? filterOptions(state.options, state.select.filter)
    : state.options;
  const submitIndex = presentation.selection === "multiple" ? submitRowIndex(visible) : -1;
  const cursor = state.select.cursor;

  // An empty message (e.g. a panel-titled menu) contributes no header rows;
  // the panel's own spacing does the separating.
  const rows = selectMessageRows(state.message, presentation.layout, theme);

  if (presentation.filter !== undefined) {
    rows.push(`  ${searchFilter(state.select.filter, presentation.filter.placeholder, theme)}`);
  }

  let featuredLead = 0;
  while (visible[featuredLead]?.featured) featuredLead += 1;
  const viewSize = selectViewSize({
    search: presentation.filter !== undefined,
    filter: state.select.filter,
    featuredLead,
    optionCount: visible.length,
  });
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(viewSize / 2), Math.max(0, visible.length - viewSize)),
  );
  const end = Math.min(start + viewSize, visible.length);
  // Hints sit in a shared column: every visible row pads its label out to the
  // widest label in view so the `· hint` tab-aligns, regardless of whether the
  // hint is persistent or shown only under the cursor.
  // The hint column aligns only to rows that actually show a hint — padding to a
  // longer label that carries no hint would open a gap before a lone hint.
  const visibleLabelWidth = visible
    .slice(start, end)
    .filter((option) => option.hint !== undefined || option.focusHint !== undefined)
    .reduce((width, option) => Math.max(width, option.label.length), 0);

  if (visible.length === 0) {
    rows.push(`  ${c.dim("(no matches)")}`);
  }

  appendSelectOptionRows({
    rows,
    state,
    presentation,
    visible,
    start,
    end,
    cursor,
    visibleLabelWidth,
    theme,
  });
  appendSubmitRow(rows, cursor, submitIndex, theme);

  if (visible.length > end - start) {
    rows.push(`  ${c.dim(`↑↓ ${visible.length} options, showing ${start + 1}–${end}`)}`);
  }

  appendSelectNotices(rows, state.notices, presentation.layout, theme, width);

  if (state.error !== undefined) {
    rows.push("", `  ${c.red(state.error)}`);
  }

  rows.push(...questionFooter(selectFooterHints(presentation, visible, cursor), theme));
  return rows.map((row) => clip(row, width));
}

/** Paints a text question section: message, a caret-bearing input line, hints. */
export function renderTextQuestion(
  state: SetupTextPanelState,
  theme: Theme,
  width: number,
  caretVisible: boolean,
): string[] {
  const c = theme.colors;
  const rows: string[] = [];
  for (const notice of state.notices ?? []) {
    const body = notice.tone === "info" ? c.dim(notice.text) : notice.text;
    rows.push(`${toneGlyph(notice.tone, theme)} ${body}`);
  }
  rows.push(...state.message.split("\n").map((line) => `  ${c.bold(line)}`));

  const budget = Math.max(4, width - 4);
  const display = state.mask
    ? {
        text: "•".repeat(graphemes(state.editor.text).length),
        cursor: graphemes(state.editor.text.slice(0, state.editor.cursor)).length,
      }
    : { text: state.editor.text, cursor: state.editor.cursor };
  const { before, under, after } = visibleLine(display, budget, theme.glyph.ellipsis);
  const caret = caretVisible ? c.cyan(theme.glyph.caret) : " ";
  const body =
    state.editor.text.length === 0 && state.placeholder !== undefined
      ? `${caret}${c.dim(state.placeholder)}`
      : `${renderInputText(before)}${caret}${renderInputText(under)}${renderInputText(after)}`;
  rows.push(`  ${body}`);

  if (state.error !== undefined) {
    rows.push("", `  ${c.red(state.error)}`);
  }

  rows.push(...questionFooter(["enter to submit", "esc to cancel"], theme));
  return rows.map((row) => clip(row, width));
}

/**
 * Paints a static acknowledgement section (for the flow panel): a heading and
 * dim body lines where option rows normally sit, held until the user
 * dismisses it. There is nothing to cancel — the text is the point — so the
 * footer advertises only enter.
 */
export function renderAcknowledgeQuestion(
  state: SetupAcknowledgePanelState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const rows: string[] = [`  ${c.bold(state.message)}`];
  if (state.lines.length > 0) {
    rows.push("");
    for (const line of state.lines) {
      rows.push(`  ${c.dim(line)}`);
    }
  }
  rows.push(...questionFooter(["enter to continue"], theme));
  return rows.map((row) => clip(row, width));
}
