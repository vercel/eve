/** Pure borderless setup menus. Interaction and terminal lifecycle belong to the renderer. */

import type { ChannelSetupAction, PromptOption } from "#setup/cli/index.js";
import { renderOptionRow, resolveOptionRowState } from "#setup/cli/option-row.js";
import {
  filterOptions,
  submitRowIndex,
  type SearchActionOption,
  type SelectState,
} from "#setup/cli/select-state.js";
import type { PlannerNavigation, SelectMetadata, SelectNotice } from "#setup/prompter.js";

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
  /** Inert context rendered beneath the heading and above the controls. */
  description?: string;
  /** Labeled facts rendered beneath the description and above the controls. */
  metadata?: readonly SelectMetadata[];
  error?: string;
  /** Outcome lines from earlier menu laps, shown beneath the options. */
  notices?: readonly SelectNotice[];
  /** Optional batch-planner navigation grammar. */
  navigation?: PlannerNavigation;
}

interface SetupSelectPanelBase extends SetupQuestionPanelBase {
  options: readonly SetupPanelOption[];
  searchAction?: SearchActionOption;
  select: SelectState;
  /** Live frame rendered beside a searchable input while it loads replacement rows. */
  loadingFrame?: string;
  /** A dim-inverse affordance appended to the cursor row, e.g. ` ↵ change `. */
  cursorBadge?: string;
  /** Blink state for the active searchable field. */
  caretVisible?: boolean;
  footerHints?: readonly string[];
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
  | (SetupSelectPanelBase & {
      kind: "searchable-multi";
      layout?: "stacked";
      placeholder?: string;
    })
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

/** One already-resolved animation frame. */
export interface FlowPanelIndicator {
  glyph: string;
}

/** One live flow status after its animation frame is resolved. */
export interface FlowPanelStatus {
  text: string;
  indicator: FlowPanelIndicator;
}

export type FlowPanelContent =
  | {
      kind: "question";
      title?: string;
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
  /** Progress owned by an enclosing journey, visible through nested questions and waits. */
  navigation?: PlannerNavigation;
  lines: readonly FlowPanelLine[];
  content: FlowPanelContent;
}

/** How many option rows a searchable panel shows before windowing. */
const SEARCH_VIEW_SIZE = 8;

/** The railed searchable list's constant viewport. */
const RAILED_VIEW_SIZE = 5;

/** The flow panel keeps only the freshest progress in view. */
const FLOW_PANEL_LINE_CAP = 6;

function questionFooter(hints: readonly string[], theme: Theme, width?: number): string[] {
  const c = theme.colors;
  const text = hints.join(` ${theme.glyph.dot} `);
  const lines = width === undefined ? [text] : wrapVisibleLine(text, Math.max(1, width - 3));
  return ["", ...lines.map((line) => `  ${c.dim(line)}`)];
}

const BOLD_OR_DIM_CLOSE = "\x1b[22m";
const DIM_OPEN = "\x1b[2m";
/** Restores normal intensity for a span nested inside an otherwise dim hint. */
function solidWithinDim(text: string, theme: Theme): string {
  if (!theme.color) return text;
  return `${BOLD_OR_DIM_CLOSE}${text}${DIM_OPEN}`;
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
  return theme.colors.green(indicator.glyph);
}

function renderFlowPanelStatus(status: FlowPanelStatus, theme: Theme): string {
  return `${renderIndicator(status.indicator, theme)} ${theme.colors.dim(status.text)}`;
}

export function flowMessageRows(lines: readonly FlowPanelLine[], theme: Theme): string[] {
  const c = theme.colors;
  const rows: string[] = [];
  const recent = lines.slice(-FLOW_PANEL_LINE_CAP);
  for (const line of recent) {
    const text = line.text.split("\n");
    for (const [index, part] of text.entries()) {
      const body = line.tone === "info" ? c.dim(part) : part;
      const prefix = index === 0 ? `${toneGlyph(line.tone, theme)} ` : "  ";
      rows.push(`  ${prefix}${body}`);
    }
  }
  if (recent.length > 0) {
    rows.push("");
  }

  return rows;
}

/**
 * Paints the setup flow panel. Everything a running command produces lives
 * here — progress, questions, the status indicator — and the panel vanishes
 * wholesale when the command resolves; only the command echo and the elbow
 * outcome persist in the transcript.
 */
export function renderFlowPanel(state: FlowPanelState, theme: Theme, width: number): string[] {
  const c = theme.colors;
  // Avoid the terminal's final column: writing into it can trigger an implicit
  // wrap that the live-region row counter cannot observe, leaking old frames.
  const rows: string[] = [];
  const title =
    state.content.kind === "question" ? (state.content.title ?? state.title) : state.title;
  if (title.length > 0) {
    for (const line of title.split("\n")) {
      if (line.length === 0) {
        rows.push("");
        continue;
      }
      for (const wrapped of wrapVisibleLine(line, Math.max(1, width - 3))) {
        rows.push(`  ${c.bold(wrapped)}`);
      }
    }
    rows.push("");
  }
  if (state.navigation?.kind === "planner") {
    rows.push(...plannerStepRows(state.navigation, undefined, theme));
  }

  rows.push(...flowMessageRows(state.lines, theme));

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
        for (const line of state.content.preview.split("\n")) {
          rows.push(`    ${c.dim(line)}`);
        }
      }
      break;
    case "preview": {
      const [first, ...rest] = state.content.text.split("\n");
      rows.push(`  ${renderIndicator(state.content.indicator, theme)} ${c.dim(first ?? "")}`);
      for (const line of rest) rows.push(`    ${c.dim(line)}`);
      break;
    }
    case "idle":
      // A flow between phases must never look dead: boxes run subprocesses
      // without narrating every gap, so the panel keeps a live pulse.
      rows.push(`  ${renderIndicator(state.content.indicator, theme)} ${c.dim("Working…")}`);
      break;
  }

  // One breathable left margin for everything under the rule; blank rows
  // stay empty so spacing assertions and trailing-whitespace trims hold.
  return rows.map((row) => (row.length === 0 ? clip(row, width) : clip(` ${row}`, width)));
}

function optionRow(input: {
  option: SetupPanelOption;
  isCursor: boolean;
  isChecked: boolean;
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
      placeholder: theme.glyph.option,
      dot: railed ? "" : theme.glyph.dot,
      warning: theme.glyph.warning,
    },
    label: option.label,
    hint: option.hint,
    focusHint: option.focusHint,
    accent: option.accent,
    isCursor: input.isCursor,
    state: resolveOptionRowState(option, input.isChecked),
    placeholder: false,
    presentation: "minimal",
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
        layout: state.layout ?? "plain",
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

function canNavigateBack(navigation: PlannerNavigation): boolean {
  return navigation.activeStep > (navigation.firstNavigableStep ?? 0);
}

function canNavigateForward(navigation: PlannerNavigation): boolean {
  return (
    navigation.activeStep >= (navigation.firstNavigableStep ?? 0) &&
    navigation.activeStep < navigation.steps.length - 1
  );
}

function plannerStepRows(
  navigation: Extract<SetupQuestionPanelBase["navigation"], { kind: "planner" }>,
  activeCount: number | undefined,
  theme: Theme,
): string[] {
  const labels = navigation.steps.map((step, index) => {
    const resolvedCount = index === navigation.activeStep ? activeCount : step.count;
    const count = resolvedCount === undefined || resolvedCount === 0 ? "" : ` (${resolvedCount})`;
    const complete = step.complete === true ? `${theme.glyph.success} ` : "";
    const text = `${complete}${step.label}${count}`;
    return index === navigation.activeStep
      ? theme.colors.bold(` ${text}`)
      : step.complete === true
        ? theme.colors.green(text)
        : theme.colors.dim(text);
  });
  const progress = labels.flatMap((label, index) => {
    if (index === labels.length - 1) return [label];
    const separator =
      navigation.activeStep === index && canNavigateForward(navigation)
        ? "  →  "
        : navigation.activeStep === index + 1 && canNavigateBack(navigation)
          ? "  ←  "
          : "  ·  ";
    return [label, theme.colors.dim(separator)];
  });
  return [`  ${progress.join("")}`, ""];
}

function selectMessageRows(
  message: string,
  layout: SelectLayout,
  theme: Theme,
  width: number,
): string[] {
  if (message === "") return [];

  const rows = message.split("\n").flatMap((line, index) => {
    const emphasized = layout === "stacked" || index > 0;
    return wrapVisibleLine(line, Math.max(1, width - 4)).map(
      (wrapped) => `  ${emphasized ? theme.colors.bold(wrapped) : wrapped}`,
    );
  });
  rows.push("");
  return rows;
}

function searchFilter(
  filter: string,
  placeholder: string | undefined,
  loadingFrame: string | undefined,
  caretVisible: boolean,
  theme: Theme,
  railed: boolean,
): string {
  const caret = caretVisible ? theme.colors.dim(theme.glyph.caret) : " ";
  let input = caret;
  if (railed) {
    input =
      filter.length === 0
        ? renderInputWithBlockCursor({
            before: "",
            under: "s",
            after: "earch…",
            visible: caretVisible,
            inverse: theme.colors.inverse,
            render: theme.colors.dim,
          })
        : `${filter}${caret}`;
    if (loadingFrame !== undefined) input += ` ${theme.colors.yellow(loadingFrame)}`;
    return input;
  }
  if (filter.length > 0) {
    input = filter + caret;
  } else if (placeholder !== undefined) {
    input = theme.colors.dim(`> ${placeholder}`);
  }
  if (loadingFrame === undefined) return input;
  return `${input} ${theme.colors.yellow(loadingFrame)}`;
}

/**
 * Whether a select renders as the compact searchable list behind the model
 * catalog, team, and project pickers. Its filter line leads the options and
 * the focused row uses bold weight rather than a cursor marker.
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
  optionCount: number;
  railed: boolean;
  stacked: boolean;
}): number {
  if (!input.search) return input.optionCount;
  // The railed list keeps a constant five-row viewport. Stacked search rows
  // need the same minimum breadth: a single visible card reads like it changes
  // into the next choice when the cursor moves.
  if (input.railed) return RAILED_VIEW_SIZE;
  if (input.stacked) return Math.min(input.optionCount, SEARCH_VIEW_SIZE);
  // Featured choices are ordered to the top, not treated as the whole initial
  // viewport. The planner still opens on a useful compact window after them.
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
    const editingKey = presentation.edit?.editor.kind === "key" && isCursor;
    const rowOption = {
      ...rendered,
      hint: (
        rendered.hint ?? (isCursor || option.disabled ? option.description : undefined)
      )?.replace(/\s*\n\s*/gu, " "),
    };
    if (editingKey) rowOption.hint = undefined;
    const railed = isRailedSearch(presentation);
    // Focused rows use bold weight; only an explicit badge such as the provider
    // picker's `↵ change` adds another affordance.
    const rowBadge = state.cursorBadge;
    const badge = isCursor && rowBadge !== undefined ? ` ${rowBadge}` : "";
    rows.push(
      `  ${optionRow({
        option: rowOption,
        isCursor,
        isChecked:
          presentation.selection === "multiple"
            ? state.select.selected.has(option.value)
            : option.checked === true,
        railed,
        hintPadding: Math.max(0, visibleLabelWidth - rowOption.label.length),
        theme,
      })}${badge}`,
    );

    if (editingKey && rendered.hint) rows.push(`     ${rendered.hint}`);
  }
  return renderedTrailingTaskAction;
}

function appendSubmitRow(rows: string[], cursor: number, submitIndex: number, theme: Theme): void {
  if (submitIndex < 0) return;
  const onSubmit = cursor === submitIndex;
  const content = onSubmit ? theme.colors.bold("Submit") : theme.colors.dim("Submit");
  rows.push("", `     ${content}`);
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
  plannerNavigation: PlannerNavigation | undefined,
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
  if (plannerNavigation !== undefined) {
    const canGoBack = canNavigateBack(plannerNavigation);
    const canGoForward = canNavigateForward(plannerNavigation);
    hints.push(presentation.selection === "multiple" ? "space/enter toggle" : "enter to select");
    if (canGoBack && canGoForward) hints.push("←/→ steps");
    else if (canGoBack) hints.push("← back");
    else if (canGoForward) hints.push("→ next");
    hints.push(cancelHint);
    return hints;
  }
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
  const plannerNavigation = state.navigation?.kind === "planner" ? state.navigation : undefined;
  const submitIndex =
    presentation.selection === "multiple" && plannerNavigation === undefined
      ? submitRowIndex(visible)
      : -1;
  const cursor = state.select.cursor;

  const railed = isRailedSearch(presentation);
  const rows = [
    ...(state.navigation?.kind === "planner"
      ? plannerStepRows(
          state.navigation,
          presentation.selection === "multiple" ? state.select.selected.size : undefined,
          theme,
        )
      : []),
    ...selectMessageRows(state.message, presentation.layout, theme, width),
  ];
  if (state.description !== undefined || state.metadata !== undefined) {
    if (rows.at(-1) === "") rows.pop();
    if (state.description !== undefined) {
      for (const line of wrapVisibleLine(state.description, Math.max(1, width - 4))) {
        rows.push(`  ${c.dim(line)}`);
      }
    }
    for (const { label, value } of state.metadata ?? []) {
      const prefix = `${label}: `;
      const wrapped = wrapVisibleLine(value, Math.max(1, width - 4 - prefix.length));
      rows.push(`  ${c.dim(`${prefix}${wrapped[0] ?? ""}`)}`);
      for (const line of wrapped.slice(1)) {
        rows.push(`  ${c.dim(`${" ".repeat(prefix.length)}${line}`)}`);
      }
    }
    rows.push("");
  }

  if (presentation.filter !== undefined) {
    const filter = searchFilter(
      state.select.filter,
      presentation.filter.placeholder,
      state.loadingFrame,
      state.caretVisible ?? true,
      theme,
      railed,
    );
    rows.push(`  ${railed ? " " : ""}${filter}`);
  }

  const viewSize = selectViewSize({
    search: presentation.filter !== undefined,
    filter: state.select.filter,
    optionCount: visible.length,
    railed,
    stacked: presentation.layout === "stacked",
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
  if (plannerNavigation !== undefined && presentation.selection === "multiple") {
    const count = state.select.selected.size;
    rows.push("", `  ${c.dim(`${count} selected`)}`);
  }

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
      state.footerHints ??
        (railed
          ? ["Enter select", "Esc back"]
          : selectFooterHints(presentation, visible, cursor, plannerNavigation)),
      theme,
      width,
    ),
  );
  return rows.map((row) => clip(row, width));
}

/**
 * A dim, background-free selection badge carrying the Enter affordance, e.g.
 * `↵`, `↵ change`, `↵ validate`.
 */
export function enterBadge(theme: Theme, label?: string): string {
  const c = theme.colors;
  return c.dim(label === undefined ? theme.glyph.enter : `${theme.glyph.enter} ${label}`);
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
  if (state.message !== "")
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
  const rows: string[] = state.message === "" ? [] : [`  ${c.bold(state.message)}`];
  if (state.lines.length > 0) {
    rows.push("");
    for (const line of state.lines) {
      rows.push(`  ${c.dim(line)}`);
    }
  }
  rows.push(...questionFooter(["enter to continue"], theme));
  return rows.map((row) => clip(row, width));
}
