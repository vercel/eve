import type { Writable } from "node:stream";

import { wrapTextWithPrefix } from "@clack/core";

import { renderOptionRow, resolveOptionRowState, UNICODE_ROW_GLYPHS } from "./option-row.js";

/** Terminal lifecycle state accepted by the shared prompt renderer. */
export type PromptState = "initial" | "active" | "submit" | "cancel" | "error";

/** Scalar values supported by shared prompt options. */
export type PromptValue = string | number | boolean;

/** Coloring operations used by prompt rendering without coupling to a color library. */
export interface PromptColors {
  bold(text: string): string;
  cyan(text: string): string;
  dim(text: string): string;
  gray(text: string): string;
  green(text: string): string;
  inverse(text: string): string;
  red(text: string): string;
  strikethrough(text: string): string;
  white(text: string): string;
  yellow(text: string): string;
}

/** A selectable item rendered by the shared multi-select prompt. */
export interface PromptOption<T extends PromptValue> {
  value: T;
  label: string;
  /** Short inline annotation shown in parentheses while the option is highlighted. */
  hint?: string;
  /** Short inline annotation shown dimmed only while the cursor is on this row. */
  focusHint?: string;
  /**
   * Longer, display-only explanation shown dimmed on the line below the option
   * while it is highlighted during navigation. It is navigation-only: once a
   * choice is submitted only the label remains.
   */
  description?: string;
  /** Cursor-pointer/active-label accent; "warning" turns them yellow for an attention row. */
  accent?: "warning";
  disabled?: boolean;
  disabledReason?: string;
  /**
   * "warning" renders the disabled reason in yellow with a dimmed (not struck)
   * label — unavailable here but actionable elsewhere, unlike the default
   * disabled styling, which marks a hard conflict.
   */
  disabledReasonTone?: "warning";
  /**
   * Completed work: renders with a check and remains cursor-addressable for
   * contextual feedback, but cannot be selected or toggled.
   */
  completed?: boolean;
  /**
   * Marks a mandatory row that is always selected and cannot be toggled off: the
   * cursor skips it and it renders a dimmed check. Mutually exclusive with
   * `disabled`, which marks an unavailable row.
   */
  locked?: boolean;
  /** Parenthetical shown after a locked row's label, e.g. "always available". */
  lockedReason?: string;
  /**
   * A leading run of featured options forms a searchable picker's default
   * viewport: with no filter typed, only they are in view, and scrolling or
   * filtering reaches the rest of the list. Featured options must be sorted
   * to the front. Meaningless without `search`.
   */
  featured?: boolean;
}

/** Vertical rail glyph used by the onboarding-style terminal UI. */
export const RAIL = "│";
/** Closing corner glyph used by the onboarding-style terminal UI. */
export const CORNER = "└";

const BULLET_OPEN = "△";
const BULLET_FILLED = "▲";

/** Renders the lifecycle marker shown at the prompt header. */
export function bulletFor(state: PromptState, colors: PromptColors): string {
  switch (state) {
    case "initial":
    case "active":
      return colors.green(BULLET_OPEN);
    case "submit":
      return colors.green(BULLET_FILLED);
    case "cancel":
      return colors.gray(BULLET_FILLED);
    case "error":
      return colors.red(BULLET_FILLED);
  }
}

/** Renders a rail with color determined by the prompt lifecycle state. */
export function railFor(state: PromptState, colors: PromptColors): string {
  switch (state) {
    case "initial":
    case "active":
      return colors.white(RAIL);
    case "submit":
      return colors.green(RAIL);
    case "cancel":
      return colors.gray(RAIL);
    case "error":
      return colors.red(RAIL);
  }
}

/** Renders a closing corner with color determined by the prompt lifecycle state. */
export function cornerFor(state: PromptState, colors: PromptColors): string {
  switch (state) {
    case "initial":
    case "active":
      return colors.white(CORNER);
    case "submit":
      return colors.green(CORNER);
    case "cancel":
      return colors.gray(CORNER);
    case "error":
      return colors.red(CORNER);
  }
}

/** Formats the rail-and-title header common to onboarding prompts. */
export function formatPromptHeader(
  state: PromptState,
  message: string,
  options: {
    colors: PromptColors;
    leadingRail?: "white" | "green";
  },
): string {
  const leadingRail =
    options.leadingRail === "green" ? options.colors.green(RAIL) : options.colors.white(RAIL);
  return `${leadingRail}\n${bulletFor(state, options.colors)}  ${message}\n`;
}

/**
 * Renders a resolved prompt as one line: the question dimmed and moved to the
 * front as a label, followed by the chosen answer. Replaces the two-line
 * "bullet + question" then "rail + answer" submit layout so completed steps
 * read compactly while keeping the bullet and leading rail that anchor the
 * step in the vertical chain. `answer` is expected to already carry its own
 * styling; the empty case drops the trailing space.
 */
export function formatPromptSubmission(
  state: PromptState,
  message: string,
  answer: string,
  options: {
    colors: PromptColors;
    leadingRail?: "white" | "green";
  },
): string {
  const leadingRail =
    options.leadingRail === "green" ? options.colors.green(RAIL) : options.colors.white(RAIL);
  const tail = answer === "" ? "" : ` ${answer}`;
  return `${leadingRail}\n${bulletFor(state, options.colors)}  ${options.colors.dim(message)}${tail}`;
}

/** Formats the banner that opens an onboarding-style interaction. */
export function formatPromptOpener(title: string, subtitle: string, colors: PromptColors): string {
  const logo = colors.bold(colors.white("▲"));
  return `\n${logo}   ${colors.bold(title)}\n    ${colors.dim(subtitle)}\n${colors.white(RAIL)}\n`;
}

/** Formats the successful closing message for an onboarding-style interaction. */
export function formatPromptOutro(message: string, colors: PromptColors): string {
  const indented = message.replace(/\n/g, "\n   ");
  return `${colors.green(RAIL)}\n${colors.green("●")}  ${indented}\n`;
}

/** Formats the cancellation closing message for an onboarding-style interaction. */
export function formatPromptCancellation(message: string, colors: PromptColors): string {
  const indented = message.replace(/\n/g, "\n   ");
  return `${colors.red(RAIL)}\n${colors.red("●")}  ${colors.red(indented)}\n`;
}

/** Formats receipt text under the successful rail and wraps it to the active terminal width. */
export function formatRailLine(
  text: string,
  colors: PromptColors,
  output: Writable | undefined,
): string {
  if (text === "") {
    return `${colors.green(RAIL)}\n`;
  }
  const prefix = `${colors.green(RAIL)}  `;
  return `${text
    .split("\n")
    .map((line) => (line === "" ? colors.green(RAIL) : wrapTextWithPrefix(output, line, prefix)))
    .join("\n")}\n`;
}

/** Renders the shared multi-select interaction used when adding channels. */
export function renderMultiselectPrompt<T extends PromptValue>(input: {
  colors: PromptColors;
  cursor: number;
  error?: string;
  /** Status note tucked onto the corner line while active (e.g. a quit hint). */
  footerNote?: string;
  leadingRail?: "white" | "green";
  message: string;
  options: readonly PromptOption<T>[];
  selectedValues: readonly T[];
  state: PromptState;
  /** Submit-row label, e.g. "Skip" while an optional checklist is empty. */
  submitLabel?: string;
}): string {
  const rail = railFor(input.state, input.colors);
  const head = formatPromptHeader(input.state, input.message, {
    colors: input.colors,
    leadingRail: input.leadingRail,
  });
  const selectedSet = new Set(input.selectedValues);
  // No key legend: the Submit row carries the confirm affordance. Only a list
  // with nothing left to pick explains itself.
  const emptyNotice = input.options.some((option) => !option.disabled)
    ? ""
    : `\n${rail}\n${rail}  ${input.colors.dim("(no channels available to add)")}`;

  switch (input.state) {
    case "submit": {
      const answer =
        selectedSet.size === 0
          ? input.colors.dim("(none selected)")
          : input.options
              .filter((option) => selectedSet.has(option.value))
              .map((option) => option.label)
              .join(", ");
      return formatPromptSubmission(input.state, input.message, answer, {
        colors: input.colors,
        leadingRail: input.leadingRail,
      });
    }
    case "cancel":
      return `${head}${rail}  ${input.colors.strikethrough(input.colors.dim("cancelled"))}\n${rail}`;
    case "error": {
      const rows = renderMultiselectRows({ ...input, rail });
      return `${head.trim()}\n${rail}  ${rows}${emptyNotice}\n${cornerFor(input.state, input.colors)}  ${input.colors.red(input.error ?? "")}\n`;
    }
    case "initial":
    case "active": {
      const rows = renderMultiselectRows({ ...input, rail });
      const corner = cornerWithNote(cornerFor(input.state, input.colors), input.footerNote);
      return `${head}${rail}  ${rows}${emptyNotice}\n${corner}\n`;
    }
  }
}

/** Appends a status note to the corner glyph, mirroring how errors trail the corner. */
function cornerWithNote(corner: string, note: string | undefined): string {
  return note ? `${corner}  ${note}` : corner;
}

/** Renders the shared single-select interaction used by channel setup. */
export function renderSelectPrompt<T extends PromptValue>(input: {
  colors: PromptColors;
  cursor: number;
  /** Status note tucked onto the corner line while active (e.g. a quit hint). */
  footerNote?: string;
  leadingRail?: "white" | "green";
  message: string;
  options: readonly PromptOption<T>[];
  state: PromptState;
}): string {
  const rail = railFor(input.state, input.colors);
  const head = formatPromptHeader(input.state, input.message, {
    colors: input.colors,
    leadingRail: input.leadingRail,
  });
  const row = input.options[input.cursor];

  switch (input.state) {
    case "submit": {
      const answer = row ? row.label : "";
      return formatPromptSubmission(input.state, input.message, answer, {
        colors: input.colors,
        leadingRail: input.leadingRail,
      });
    }
    case "cancel": {
      const label = row ? input.colors.strikethrough(input.colors.dim(row.label)) : "";
      return `${head}${rail}  ${label}\n${rail}`;
    }
    case "initial":
    case "active":
    case "error": {
      const width = labelColumnWidth(input.options);
      const rows = input.options
        .map((option, index) => {
          const isCursor = index === input.cursor;
          const row = optionRow(option, {
            colors: input.colors,
            isCursor,
            isChecked: false,
            placeholder: false,
            hintPadding: width - option.label.length,
          });
          return `${row}${descriptionLine(option, isCursor, rail, input.colors)}`;
        })
        .join(`\n${rail}  `);
      const corner = cornerWithNote(cornerFor(input.state, input.colors), input.footerNote);
      return `${head}${rail}  ${rows}\n${corner}\n`;
    }
  }
}

/** Widest label among the options, for tab-aligning the inline hint column. */
function labelColumnWidth<T extends PromptValue>(options: readonly PromptOption<T>[]): number {
  return options.reduce((width, option) => Math.max(width, option.label.length), 0);
}

/** Maps a `PromptOption` onto the shared single-column row painter. */
function optionRow<T extends PromptValue>(
  option: PromptOption<T>,
  input: {
    colors: PromptColors;
    isCursor: boolean;
    isChecked: boolean;
    placeholder: boolean;
    hintPadding: number;
  },
): string {
  return renderOptionRow({
    colors: input.colors,
    glyphs: UNICODE_ROW_GLYPHS,
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

/** The dimmed description line shown beneath the cursor row, when it has one. */
function descriptionLine<T extends PromptValue>(
  option: PromptOption<T>,
  isCursor: boolean,
  rail: string,
  colors: PromptColors,
): string {
  return isCursor && option.description && !option.disabled
    ? `\n${rail}    ${colors.dim(option.description)}`
    : "";
}

/**
 * Renders the virtual Submit row that closes every multi-select list. It has
 * no checkbox — its bold label sits in the checkbox column, trails a green
 * check, and brightens under the cursor; enter confirms the checklist only
 * from here. The label reads "Skip" while an optional checklist has nothing
 * picked (the caller computes that), so an empty confirm is honest about what
 * it does. Callers put a blank rail line above it to set it apart from the
 * options.
 */
export function renderSubmitRow(
  isCursor: boolean,
  colors: PromptColors,
  label: string = "Submit",
): string {
  const arrow = isCursor ? colors.cyan(UNICODE_ROW_GLYPHS.pointer) : " ";
  const bold = colors.bold(label);
  return `${arrow} ${isCursor ? bold : colors.dim(bold)} ${colors.green(UNICODE_ROW_GLYPHS.success)}`;
}

function renderMultiselectRows<T extends PromptValue>(input: {
  colors: PromptColors;
  cursor: number;
  options: readonly PromptOption<T>[];
  rail: string;
  selectedValues: readonly T[];
  submitLabel?: string;
}): string {
  const selectedSet = new Set(input.selectedValues);
  const width = labelColumnWidth(input.options);
  const rows = input.options
    .map((option, index) => {
      const isCursor = index === input.cursor;
      const row = optionRow(option, {
        colors: input.colors,
        isCursor,
        isChecked: selectedSet.has(option.value),
        placeholder: true,
        hintPadding: width - option.label.length,
      });
      return `${row}${descriptionLine(option, isCursor, input.rail, input.colors)}`;
    })
    .join(`\n${input.rail}  `);
  const submit = renderSubmitRow(
    input.cursor === input.options.length,
    input.colors,
    input.submitLabel,
  );
  return `${rows}\n${input.rail}\n${input.rail}  ${submit}`;
}

/** Default number of option rows shown at once by the searchable picker. */
const SEARCHABLE_VIEW_SIZE = 8;

/**
 * Mode-aware help line for the searchable picker, listing only relevant keys.
 * A multi-select keeps just the filter hint — its Submit row already carries
 * the confirm affordance.
 */
function searchableHelpLine(rail: string, colors: PromptColors, multiple: boolean): string {
  const parts = multiple
    ? [[colors.cyan("type"), "to filter"]]
    : [
        [colors.cyan("type"), "to filter"],
        [colors.cyan("enter"), "to select"],
      ];
  const body = parts
    .map(([key, label]) => `${key}${colors.dim(` ${label}`)}`)
    .join(colors.dim(" · "));
  return `\n${rail}  ${colors.dim("(")}${body}${colors.dim(")")}`;
}

/**
 * Renders the type-ahead select interaction: a filter line, a scrolling window
 * of options, and a mode-aware help line. Single-select marks the highlighted
 * row with the cursor arrow and submits it on enter; multi-select adds the
 * checkbox column, toggles rows with space or enter, and confirms from the
 * pinned Submit row (cursor index `options.length`). `options` is the
 * already-filtered visible list (with `cursor` indexing it); `submitDisplay`
 * is the precomputed answer shown once a choice is made.
 */
export function renderSearchableSelect<T extends PromptValue>(input: {
  colors: PromptColors;
  state: PromptState;
  leadingRail?: "white" | "green";
  message: string;
  multiple: boolean;
  filter: string;
  placeholder?: string;
  options: readonly PromptOption<T>[];
  cursor: number;
  selectedValues: readonly T[];
  submitDisplay: string;
  footerNote?: string;
  error?: string;
  viewSize?: number;
  /** Submit-row label, e.g. "Skip" while an optional checklist is empty. */
  submitLabel?: string;
}): string {
  const { colors } = input;
  const rail = railFor(input.state, colors);
  const head = formatPromptHeader(input.state, input.message, {
    colors,
    leadingRail: input.leadingRail,
  });

  if (input.state === "submit") {
    return formatPromptSubmission(input.state, input.message, input.submitDisplay, {
      colors,
      leadingRail: input.leadingRail,
    });
  }
  if (input.state === "cancel") {
    return `${head}${rail}  ${colors.strikethrough(colors.dim(input.filter))}${
      input.filter.trim() ? `\n${rail}` : ""
    }`;
  }

  const selectedSet = new Set(input.selectedValues);
  // With no filter, a leading run of `featured` options sizes the viewport so
  // the default view shows just the curated shortlist; scrolling past it (or
  // typing) moves the window into the full list. The "↑↓ N options" footer
  // advertises the rest.
  let featuredLead = 0;
  while (input.options[featuredLead]?.featured) featuredLead += 1;
  const baseViewSize = input.viewSize ?? SEARCHABLE_VIEW_SIZE;
  const viewSize =
    input.filter === "" && featuredLead > 0 ? Math.min(featuredLead, baseViewSize) : baseViewSize;
  // In a multi-select, the index one past the options is the Submit row; a
  // single-select cursor past the end is stale and re-homes to the top.
  const onSubmitRow = input.multiple && input.cursor >= input.options.length;
  const cursor = !onSubmitRow && input.cursor >= input.options.length ? 0 : input.cursor;

  let filterInput = colors.inverse(" ");
  if (input.filter.length > 0) {
    filterInput = input.filter + colors.inverse(" ");
  } else if (input.placeholder) {
    filterInput = colors.dim(input.placeholder);
  }

  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(viewSize / 2), Math.max(0, input.options.length - viewSize)),
  );
  const end = Math.min(start + viewSize, input.options.length);
  const window = input.options.slice(start, end);

  const width = labelColumnWidth(window);
  const optionLines =
    window.length === 0
      ? colors.dim("(no matches)")
      : window
          .map((option, index) => {
            const isCursor = !onSubmitRow && index + start === cursor;
            const row = optionRow(option, {
              colors,
              isCursor,
              isChecked: input.multiple && selectedSet.has(option.value),
              // Search gates the placeholder dot off, matching the dev TUI.
              placeholder: false,
              hintPadding: width - option.label.length,
            });
            return `${row}${descriptionLine(option, isCursor, rail, colors)}`;
          })
          .join(`\n${rail}  `);

  const submitLine = input.multiple
    ? `\n${rail}\n${rail}  ${renderSubmitRow(onSubmitRow, colors, input.submitLabel)}`
    : "";

  const moreFooter =
    input.options.length > window.length
      ? `\n${rail}  ${colors.dim(`↑↓ ${input.options.length} options, showing ${start + 1}–${end}`)}`
      : "";

  const help = searchableHelpLine(rail, colors, input.multiple);
  const body = `${rail}  ${colors.dim(" ")} ${filterInput}\n${rail}  ${optionLines}${submitLine}${moreFooter}${help}`;

  if (input.state === "error") {
    return `${head.trim()}\n${body}\n${cornerFor(input.state, colors)}  ${colors.red(input.error ?? "")}\n`;
  }
  const corner = cornerWithNote(cornerFor(input.state, colors), input.footerNote);
  return `${head}${body}\n${corner}\n`;
}
