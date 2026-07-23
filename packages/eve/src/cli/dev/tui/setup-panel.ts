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
import {
  renderOptionRow,
  renderOptionRowContinuation,
  renderCursorRow,
  resolveOptionRowState,
} from "#setup/cli/option-row.js";
import {
  filterOptions,
  submitRowIndex,
  type SearchActionOption,
  type SelectState,
} from "#setup/cli/select-state.js";
import type { SelectNotice } from "#setup/prompter.js";
import type { ModelSettingsRequest } from "#setup/flows/model.js";

import {
  modelEditorMenuRows,
  reasoningPositions,
  type ModelEditorRowId,
  type ModelEditorState,
} from "./model-editor.js";
import type { ProviderPickerPhase } from "./provider-picker.js";
import { maskLine, visibleLine, type LineState } from "./line-editor.js";
import type { Theme } from "./theme.js";
import {
  clipVisible,
  renderInputText,
  renderInputWithBlockCursor,
  visibleLength,
  wrapVisibleLine,
} from "#cli/ui/terminal-text.js";

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
  searchAction?: SearchActionOption;
  select: SelectState;
  /** Live frame rendered beside a searchable input while it loads replacement rows. */
  loadingFrame?: string;
  /** A dim-inverse affordance appended to the cursor row, e.g. ` ↵ change `. */
  cursorBadge?: string;
}

/**
 * A menu row that turns into an inline editor while the cursor rests on it.
 * `optionValue` names the row; the `editor` discriminant chooses the widget —
 * an in-place rename field, or a masked provider-key field with its own
 * validation phases. Rename defaults stay placeholders until typing begins;
 * provider keys edit in place. Layout and inline editing are orthogonal, so
 * the editor travels as a payload rather than as its own panel `kind`.
 */
interface SetupInlineEditRow {
  optionValue: string;
  caretVisible: boolean;
  editor:
    | {
        kind: "rename";
        editor: LineState;
        defaultValue: string;
        formatHint: (value: string) => string;
      }
    | {
        kind: "key";
        phase: ProviderPickerPhase;
      };
}

/**
 * Select presentation variants. The discriminant owns the interaction grammar
 * so feature combinations are deliberate rather than resolved by conditional
 * precedence inside the renderer. Inline editing is the exception: it composes
 * with a layout instead of defining one, so `inline-edit` carries both.
 */
type SetupOptionSelectPanelState =
  | (SetupSelectPanelBase & { kind: "single" })
  | (SetupSelectPanelBase & {
      kind: "search";
      layout?: "task-list";
      placeholder?: string;
    })
  | (SetupSelectPanelBase & { kind: "multi" })
  | (SetupSelectPanelBase & { kind: "searchable-multi"; placeholder?: string })
  | (SetupSelectPanelBase & { kind: "stacked" })
  | (SetupSelectPanelBase & { kind: "task-list" })
  | (SetupSelectPanelBase & {
      kind: "inline-edit";
      layout: "stacked" | "task-list";
      edit: SetupInlineEditRow;
    });

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

/** One already-resolved animation frame and its active color. */
export interface FlowPanelIndicator {
  glyph: string;
  color: "green" | "yellow";
}

/** One live flow status after its animation frame and visual intent are resolved. */
export type FlowPanelStatus =
  | { kind: "progress"; text: string; indicator: FlowPanelIndicator }
  | {
      kind: "external-action";
      text: string;
      emphasis: string;
      indicator: FlowPanelIndicator;
    };

export type FlowPanelContent =
  | {
      kind: "question";
      rows: readonly string[];
      /** The install wait keeps its indicator above the concurrent actions. */
      status?: FlowPanelStatus;
    }
  | {
      kind: "status";
      status: FlowPanelStatus;
      /** Latest child-process output shown transiently beneath the status. */
      preview?: string;
    }
  | { kind: "preview"; text: string; indicator: FlowPanelIndicator }
  | { kind: "idle"; indicator: FlowPanelIndicator };

/** The whole bordered section: title, recent progress, and one explicit mode. */
export interface FlowPanelState {
  /** The invoked command, e.g. "/deploy". Empty renders no title row. */
  title: string;
  lines: readonly FlowPanelLine[];
  content: FlowPanelContent;
}

/** How many option rows a searchable panel shows before windowing. */
const SEARCH_VIEW_SIZE = 8;

/** The railed searchable list's constant viewport. */
const RAILED_VIEW_SIZE = 5;

/** The flow panel keeps only the freshest progress in view. */
const FLOW_PANEL_LINE_CAP = 6;

function questionFooter(hints: readonly string[], theme: Theme): string[] {
  const c = theme.colors;
  return ["", `  ${c.dim(c.italic(hints.join(` ${theme.glyph.dot} `)))}`];
}

const BOLD_OR_DIM_CLOSE = "\x1b[22m";
const DIM_OPEN = "\x1b[2m";
const ANSI_FOREGROUND_COLOR = new RegExp(`${String.fromCharCode(27)}\\[(?:3[0-9]|9[0-7])m`, "g");
const BLUE_OPEN = "\x1b[34m";
const FOREGROUND_RESET = "\x1b[39m";

/**
 * Dims a line that may carry embedded bold spans (e.g. a flow bolding a
 * project name inside a hint): SGR 22 closes bold AND dim together, so dim is
 * re-opened after each close or the line's tail would render full-bright.
 */
function dimWithEmphasis(text: string, theme: Theme): string {
  return theme.colors.dim(text.replaceAll(BOLD_OR_DIM_CLOSE, `${BOLD_OR_DIM_CLOSE}${DIM_OPEN}`));
}

/** Restores normal intensity for a span nested inside an otherwise dim hint. */
function solidWithinDim(text: string, theme: Theme): string {
  if (!theme.color) return text;
  return `${BOLD_OR_DIM_CLOSE}${text}${DIM_OPEN}`;
}

/** A selected row must not inherit an authored hint color. */
function foregroundWithEmphasis(text: string): string {
  // Blue is the accent the selected row keeps (drafted values, adjust hints);
  // every other authored color normalizes to the highlight's foreground, and a
  // reset survives only when it closes a kept blue span.
  let blueOpen = false;
  return text.replaceAll(DIM_OPEN, "").replace(ANSI_FOREGROUND_COLOR, (code) => {
    if (code === BLUE_OPEN) {
      blueOpen = true;
      return code;
    }
    if (code === FOREGROUND_RESET && blueOpen) {
      blueOpen = false;
      return code;
    }
    return "";
  });
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

function renderIndicator(indicator: FlowPanelIndicator, theme: Theme): string {
  return indicator.color === "green"
    ? theme.colors.green(indicator.glyph)
    : theme.colors.yellow(indicator.glyph);
}

function renderStatusText(status: FlowPanelStatus, theme: Theme): string {
  if (status.kind === "progress") return theme.colors.dim(status.text);

  const start = status.text.indexOf(status.emphasis);
  if (start === -1) return theme.colors.dim(status.text);
  const end = start + status.emphasis.length;
  return `${theme.colors.dim(status.text.slice(0, start))}${theme.colors.yellow(
    status.text.slice(start, end),
  )}${theme.colors.dim(status.text.slice(end))}`;
}

function renderFlowPanelStatus(status: FlowPanelStatus, theme: Theme): string {
  return `${renderIndicator(status.indicator, theme)} ${renderStatusText(status, theme)}`;
}

/**
 * Paints the bordered flow panel. Everything a running command produces lives
 * here — progress, questions, the status indicator — and the panel vanishes
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
      // The install wait's question rides beneath its live status indicator.
      if (state.content.status !== undefined) {
        rows.push(`  ${renderFlowPanelStatus(state.content.status, theme)}`, "");
      }
      rows.push(...state.content.rows);
      break;
    case "status":
      rows.push(`  ${renderFlowPanelStatus(state.content.status, theme)}`);
      if (state.content.preview !== undefined) {
        rows.push(`    ${c.dim(state.content.preview)}`);
      }
      break;
    case "preview":
      rows.push(
        `  ${renderIndicator(state.content.indicator, theme)} ${c.dim(state.content.text)}`,
      );
      break;
    case "idle":
      // A flow between phases must never look dead: boxes run subprocesses
      // without narrating every gap, so the panel keeps a live pulse.
      rows.push(`  ${renderIndicator(state.content.indicator, theme)} ${c.dim("Working…")}`);
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
  /** Railed lists lead resting rows with the `▏` rail and drop the hint dot. */
  railed?: boolean;
  hintPadding?: number;
  theme: Theme;
}): string {
  const { option, theme } = input;
  const railed = input.railed === true;
  return renderOptionRow({
    colors: theme.colors,
    glyphs: {
      pointer: theme.glyph.pointer,
      selectedPointer: theme.glyph.selectedPointer,
      success: theme.glyph.success,
      placeholder: railed ? theme.glyph.caret : theme.glyph.option,
      dot: railed ? "" : theme.glyph.dot,
      warning: theme.glyph.warning,
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
  edit: SetupInlineEditRow | undefined;
}

function selectPresentation(state: SetupOptionSelectPanelState): SelectPresentation {
  switch (state.kind) {
    case "single":
      return { selection: "single", filter: undefined, layout: "plain", edit: undefined };
    case "search":
      return {
        selection: "single",
        filter: { placeholder: state.placeholder },
        layout: state.layout ?? "plain",
        edit: undefined,
      };
    case "multi":
      return { selection: "multiple", filter: undefined, layout: "plain", edit: undefined };
    case "searchable-multi":
      return {
        selection: "multiple",
        filter: { placeholder: state.placeholder },
        layout: "plain",
        edit: undefined,
      };
    case "stacked":
      return { selection: "single", filter: undefined, layout: "stacked", edit: undefined };
    case "task-list":
      return { selection: "single", filter: undefined, layout: "task-list", edit: undefined };
    case "inline-edit":
      return { selection: "single", filter: undefined, layout: state.layout, edit: state.edit };
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

function searchFilter(
  filter: string,
  placeholder: string | undefined,
  loadingFrame: string | undefined,
  theme: Theme,
  railed: boolean,
): string {
  const caret = theme.colors.dim(theme.glyph.caret);
  let input = caret;
  if (railed) {
    // The railed list's filter line: `▏ query▏`, or the dim placeholder.
    input = `${caret} ${
      filter.length > 0 ? filter + caret : theme.colors.dim(placeholder ?? "type to search")
    }`;
  } else if (filter.length > 0) {
    input = filter + caret;
  } else if (placeholder !== undefined) {
    input = theme.colors.dim(`> ${placeholder}`);
  }
  if (loadingFrame === undefined) return input;
  return `${input} ${theme.colors.yellow(loadingFrame)}`;
}

/**
 * Whether a select renders as the railed searchable list — the one component
 * behind the model catalog, team, and project pickers: `▏`-railed rows, an
 * inverse cursor row trailed by the `↵` badge, and a rail-led filter line.
 */
function isRailedSearch(presentation: SelectPresentation): boolean {
  return (
    presentation.filter !== undefined &&
    presentation.layout === "plain" &&
    presentation.selection === "single" &&
    presentation.edit === undefined
  );
}

function selectViewSize(input: {
  search: boolean;
  filter: string;
  featuredLead: number;
  optionCount: number;
  railed: boolean;
}): number {
  if (!input.search) return input.optionCount;
  // The railed list keeps a constant five-row viewport; other searchable
  // presentations open on their featured lead when one exists.
  if (input.railed) return RAILED_VIEW_SIZE;
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

function renameHint(
  option: SetupPanelOption,
  caretVisible: boolean,
  rename: Extract<SetupInlineEditRow["editor"], { kind: "rename" }>,
  theme: Theme,
): SetupPanelOption {
  const value = rename.editor.text || rename.defaultValue;
  const caretLine = { text: value, cursor: rename.editor.cursor };
  // The placeholder caret overlays its first character. Entered text uses the
  // editor's real cursor position, including the stable trailing cell at EOF.
  let editableValue = renderInputWithBlockCursor({
    ...visibleLine(caretLine, Number.POSITIVE_INFINITY),
    visible: caretVisible,
    inverse: theme.colors.inverse,
  });
  if (rename.editor.text.length > 0) {
    editableValue = solidWithinDim(editableValue, theme);
  }
  return { ...option, hint: rename.formatHint(editableValue) };
}

function keyHint(
  option: SetupPanelOption,
  caretVisible: boolean,
  key: Extract<SetupInlineEditRow["editor"], { kind: "key" }>,
  theme: Theme,
  maxHintWidth: number,
): SetupPanelOption {
  const phase = key.phase;
  if (phase.kind === "inactive") return option;

  const c = theme.colors;
  const display = maskLine(phase.editor);
  const cursorEnabled = phase.kind !== "validating" && phase.kind !== "invalid";
  // The state badge trails the input: `↵ validate` while editing, a yellow
  // `▪ validating` while the check runs, a red refusal afterward — all
  // background-free.
  let suffix = "";
  if (phase.kind === "editing") {
    suffix = `  ${enterBadge(theme, "validate")}`;
  } else if (phase.kind === "validating") {
    suffix = `  ${c.yellow(theme.glyph.validating)} ${c.dim("validating")}`;
  } else if (phase.kind === "invalid") {
    suffix = `  ${c.red(`${theme.glyph.error} API key is not valid`)}`;
  }

  const rail = `${theme.glyph.elbow} `;
  const placeholder = phase.editor.text.length === 0 ? "type your key" : undefined;
  const cursorLine = placeholder === undefined ? display : { text: placeholder, cursor: 0 };
  const inputWidth = Math.max(1, maxHintWidth - visibleLength(`${rail}${suffix}`));
  const visible = visibleLine(cursorLine, inputWidth, theme.glyph.ellipsis);
  const value = cursorEnabled
    ? renderInputWithBlockCursor({
        ...visible,
        visible: caretVisible,
        inverse: theme.colors.inverse,
      })
    : renderInputText(`${visible.before}${visible.under}${visible.after}`);
  return { ...option, hint: `${rail}${value}${suffix}` };
}

/**
 * Applies the inline editor's live hint to its bound row when the cursor rests
 * on it. Every other row — and every row when the cursor is elsewhere — renders
 * unchanged. The bound row's `editor` discriminant selects the widget.
 */
function inlineEditOption(
  option: SetupPanelOption,
  isCursor: boolean,
  edit: SetupInlineEditRow | undefined,
  theme: Theme,
  maxHintWidth: number,
): SetupPanelOption {
  if (!isCursor || edit === undefined || option.value !== edit.optionValue) return option;
  switch (edit.editor.kind) {
    case "rename":
      return renameHint(option, edit.caretVisible, edit.editor, theme);
    case "key":
      return keyHint(option, edit.caretVisible, edit.editor, theme, maxHintWidth);
  }
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
  isTrailingTaskAction: boolean,
): boolean {
  // A type-ahead list draws no placeholder dots — the filter row leads instead.
  const isFiltered = presentation.filter !== undefined && presentation.layout !== "task-list";
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
  width: number;
  theme: Theme;
}): boolean {
  const {
    rows,
    state,
    presentation,
    visible,
    start,
    end,
    cursor,
    visibleLabelWidth,
    width,
    theme,
  } = input;
  const c = theme.colors;
  let renderedTrailingTaskAction = false;

  for (let index = start; index < end; index += 1) {
    const option = visible[index]!;
    const isCursor = index === cursor;
    const isTrailingTaskAction =
      presentation.layout === "task-list" && option.trailingAction === true;
    if (isTrailingTaskAction) {
      appendSelectNotices(rows, state.notices, presentation.layout, theme, width);
      renderedTrailingTaskAction = true;
    }
    if (isTrailingTaskAction && (index > start || (state.notices?.length ?? 0) > 0)) {
      rows.push("");
    }

    const inlineHintWidth =
      presentation.layout === "stacked"
        ? Math.max(1, width - 6)
        : Math.max(1, width - Math.max(visibleLabelWidth, option.label.length) - 9);
    const rendered = inlineEditOption(option, isCursor, presentation.edit, theme, inlineHintWidth);
    const { option: rowOption, stackedHint } = optionWithoutStackedHint(
      rendered,
      presentation.layout,
    );
    const railed = isRailedSearch(presentation);
    // Railed lists carry the Enter affordance on the cursor row by default;
    // an explicit cursorBadge (the provider picker's `↵ change`) still wins.
    const rowBadge =
      state.cursorBadge ?? (railed && !isTrailingTaskAction ? enterBadge(theme) : undefined);
    const badge = isCursor && rowBadge !== undefined ? ` ${rowBadge}` : "";
    rows.push(
      `  ${optionRow({
        option: rowOption,
        isCursor,
        isChecked:
          presentation.selection === "multiple"
            ? state.select.selected.has(option.value)
            : option.checked === true,
        placeholder: railed || optionUsesPlaceholder(presentation, isTrailingTaskAction),
        railed,
        hintPadding: Math.max(0, visibleLabelWidth - rowOption.label.length),
        theme,
      })}${badge}`,
    );

    if (stackedHint !== undefined) {
      const editRow = presentation.edit;
      const isActiveProviderKey =
        isCursor &&
        editRow !== undefined &&
        editRow.optionValue === option.value &&
        editRow.editor.kind === "key" &&
        editRow.editor.phase.kind !== "inactive";
      for (const line of stackedHint.split("\n")) {
        const renderedHint = !isCursor
          ? dimWithEmphasis(line, theme)
          : isActiveProviderKey
            ? line
            : foregroundWithEmphasis(line);
        rows.push(`  ${renderOptionRowContinuation(renderedHint)}`);
      }
    }
    // Disabled descriptions explain why an inert row cannot be selected, so
    // keep them visible even though the cursor skips that row.
    if (option.description !== undefined && (option.disabled === true || isCursor)) {
      rows.push(`  ${renderOptionRowContinuation(c.dim(option.description))}`);
    }
    if (presentation.layout === "stacked" && index < end - 1) rows.push("");
  }
  return renderedTrailingTaskAction;
}

function appendSubmitRow(rows: string[], cursor: number, submitIndex: number, theme: Theme): void {
  if (submitIndex < 0) return;
  const onSubmit = cursor === submitIndex;
  const content = onSubmit
    ? `${theme.glyph.selectedPointer} ${theme.colors.bold("Submit")}`
    : "  Submit";
  rows.push("", `  ${renderCursorRow(content, onSubmit, theme.colors)}`);
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
  let cancelHint = "esc to cancel";
  const edit = presentation.edit;
  if (edit !== undefined && visible[cursor]?.value === edit.optionValue) {
    if (edit.editor.kind === "key") {
      const phase = edit.editor.phase;
      if (phase.kind !== "inactive" && phase.editor.text.length > 0) {
        cancelHint = "esc to clear";
      }
      if (phase.kind === "validating") return [cancelHint];
      hints.push("type your key");
    } else {
      hints.push("type to rename");
    }
  }
  if (presentation.filter !== undefined) hints.push("type to filter");
  hints.push("↑/↓ move");
  hints.push(presentation.selection === "multiple" ? "space to toggle" : "enter to select");
  if (presentation.selection === "multiple") hints.push("enter on Submit to confirm");
  hints.push(cancelHint);
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
    ? filterOptions(state.options, state.select.filter, state.searchAction)
    : state.options;
  const submitIndex = presentation.selection === "multiple" ? submitRowIndex(visible) : -1;
  const cursor = state.select.cursor;

  const railed = isRailedSearch(presentation);
  const rows = selectMessageRows(state.message, presentation.layout, theme);

  if (presentation.filter !== undefined) {
    // The railed filter line indents one extra cell so its rail sits in the
    // option rows' glyph column.
    rows.push(
      `  ${railed ? " " : ""}${searchFilter(
        state.select.filter,
        presentation.filter.placeholder,
        state.loadingFrame,
        theme,
        railed,
      )}`,
    );
  }

  let featuredLead = 0;
  while (visible[featuredLead]?.featured) featuredLead += 1;
  const viewSize = selectViewSize({
    search: presentation.filter !== undefined,
    filter: state.select.filter,
    featuredLead,
    optionCount: visible.length,
    railed,
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

  const renderedTrailingTaskAction = appendSelectOptionRows({
    rows,
    state,
    presentation,
    visible,
    start,
    end,
    cursor,
    visibleLabelWidth,
    width,
    theme,
  });
  appendSubmitRow(rows, cursor, submitIndex, theme);

  // The railed list scrolls silently: no count row, and Esc is the only
  // footer hint — typing, arrows, and the ↵ badge carry themselves.
  if (!railed && visible.length > end - start) {
    rows.push(`  ${c.dim(`↑↓ ${visible.length} options, showing ${start + 1}–${end}`)}`);
  }

  if (!renderedTrailingTaskAction) {
    appendSelectNotices(rows, state.notices, presentation.layout, theme, width);
  }

  if (state.error !== undefined) {
    rows.push("", `  ${c.red(state.error)}`);
  }

  rows.push(
    ...questionFooter(
      railed ? ["esc to cancel"] : selectFooterHints(presentation, visible, cursor),
      theme,
    ),
  );
  return rows.map((row) => clip(row, width));
}

/** The composite Change-model screen's inputs: the resolved request plus live state. */
export interface ModelEditorPanelInput {
  request: ModelSettingsRequest;
  state: ModelEditorState;
}

const MODEL_EDITOR_MESSAGE = "Select the model";

/**
 * A dim, background-free selection badge carrying the Enter affordance, e.g.
 * `↵`, `↵ change`, `↵ validate`.
 */
export function enterBadge(theme: Theme, label?: string): string {
  const c = theme.colors;
  return c.dim(label === undefined ? theme.glyph.enter : `${theme.glyph.enter} ${label}`);
}

/**
 * A discrete reasoning track: `●` below the current notch, `◉` on it, `○`
 * above, joined by `─` connectors. `accent` paints the covered stretch —
 * notches and connectors up to the current position — blue. `index` -1 means
 * unset: an all-`○` track with no fill.
 */
export function reasoningTrack(input: {
  count: number;
  index: number;
  connectorWidth: number;
  accent: boolean;
  theme: Theme;
}): string {
  const { count, index, theme } = input;
  const glyphs = theme.glyph;
  const connector = glyphs.trackLine.repeat(input.connectorWidth);
  const pieces: string[] = [];
  for (let at = 0; at < count; at += 1) {
    if (at > 0) pieces.push(connector);
    pieces.push(
      at < index ? glyphs.trackFilled : at === index ? glyphs.trackCurrent : glyphs.trackEmpty,
    );
  }
  if (!input.accent || index < 0) return pieces.join("");
  // Pieces alternate notch/connector; the covered stretch ends at the current
  // notch, which sits at piece position 2 * index.
  const covered = pieces.slice(0, 2 * index + 1).join("");
  return `${theme.colors.blue(covered)}${pieces.slice(2 * index + 1).join("")}`;
}

/**
 * Paints the Change-model screen: a value menu whose reasoning and tier rows
 * adjust inline with left/right, and whose Model row opens the searchable
 * catalog.
 */
export function renderModelEditorQuestion(
  input: ModelEditorPanelInput,
  theme: Theme,
  width: number,
): string[] {
  const { request, state } = input;
  switch (state.screen.kind) {
    case "menu":
      return renderModelEditorMenu(input, state.screen.cursor, theme, width);
    case "model":
      return renderModelEditorModelScreen(request, state.screen.select, theme, width);
  }
}

/**
 * The value menu rides the ordinary stacked-select painter: each row's hint
 * line is the drafted value (mini track, `fast ↯`, the slug), dim at rest and
 * accent-keeping under the cursor.
 */
function renderModelEditorMenu(
  input: ModelEditorPanelInput,
  cursor: ModelEditorRowId,
  theme: Theme,
  width: number,
): string[] {
  const { request, state } = input;
  const { draft } = state;
  const rows = modelEditorMenuRows(request, draft, state.capabilities);

  const options: SetupPanelOption[] = rows.map((row) => {
    if (row.disabled === true && row.value === "model") {
      // The fixed model still shows its id; the description carries the reason.
      return draft.modelId === null ? { ...row } : { ...row, hint: draft.modelId };
    }
    if (row.disabled === true || row.value === "done") return { ...row };
    switch (row.value) {
      case "model":
        return { ...row, hint: draft.modelId ?? undefined };
      case "reasoning": {
        const positions = reasoningPositions(state.capabilities, draft.reasoning);
        const index = draft.reasoning === "default" ? -1 : positions.indexOf(draft.reasoning);
        const track = reasoningTrack({
          count: positions.length,
          index,
          connectorWidth: 1,
          accent: row.value === cursor,
          theme,
        });
        const level = draft.reasoning === "default" ? "provider default" : draft.reasoning;
        // Track first: the notches hold a fixed column while the
        // variable-width level name trails, so nothing jumps on adjust.
        return { ...row, hint: `${track} ${level}` };
      }
      case "tier":
        return { ...row, hint: draft.tier === "priority" ? `fast ${theme.glyph.fast}` : "normal" };
      default:
        return { ...row };
    }
  });

  const index = Math.max(
    0,
    options.findIndex((option) => option.value === cursor),
  );
  return renderSelectQuestion(
    {
      kind: "stacked",
      message: "",
      options,
      select: { filter: "", cursor: index, selected: new Set() },
    },
    theme,
    width,
  );
}

/** The catalog sub-screen: `▏`-railed id rows under a `▏` filter line. */
function renderModelEditorModelScreen(
  request: ModelSettingsRequest,
  select: SelectState,
  theme: Theme,
  width: number,
): string[] {
  // The catalog list IS the shared railed searchable select — the same
  // component behind the team and project pickers.
  return renderSelectQuestion(
    {
      kind: "search",
      message: MODEL_EDITOR_MESSAGE,
      options: request.model.kind === "pick" ? request.model.options : [],
      placeholder: "type to search",
      select,
    },
    theme,
    width,
  );
}

/** Paints a text question section: message, a block-cursor input line, hints. */
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
  const display = state.mask ? maskLine(state.editor) : state.editor;
  const placeholder = state.editor.text.length === 0 ? state.placeholder : undefined;
  const cursorLine = placeholder === undefined ? display : { text: placeholder, cursor: 0 };
  const body = renderInputWithBlockCursor({
    ...visibleLine(cursorLine, budget, theme.glyph.ellipsis),
    visible: caretVisible,
    inverse: c.inverse,
    render: placeholder === undefined ? renderInputText : (text) => c.dim(renderInputText(text)),
  });
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
