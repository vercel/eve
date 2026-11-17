import type { Writable } from "node:stream";

import { wrapTextWithPrefix } from "#compiled/@clack/core/index.js";

import {
  renderCursorRow,
  renderOptionRow,
  renderOptionRowContinuation,
  resolveOptionRowState,
  UNICODE_ROW_GLYPHS,
} from "./option-row.js";

export type PromptState = "initial" | "active" | "submit" | "cancel" | "error";

export type PromptValue = string | number | boolean;

export interface PromptColors {
  blue(text: string): string;
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

export interface PromptOption<T extends PromptValue> {
  value: T;
  label: string;
  keywords?: readonly string[];
  trailingAction?: boolean;
  hint?: string;
  focusHint?: string;
  description?: string;
  accent?: "warning";
  disabled?: boolean;
  disabledReason?: string;
  disabledReasonTone?: "warning";
  completed?: boolean;
  locked?: boolean;
  lockedReason?: string;
  featured?: boolean;
  checked?: boolean;
}

export const RAIL = "│";
export const CORNER = "└";

const BULLET_OPEN = "△";
const BULLET_FILLED = "▲";

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

export function formatPromptOpener(title: string, subtitle: string, colors: PromptColors): string {
  const logo = colors.bold(colors.white("▲"));
  return `\n${logo}   ${colors.bold(title)}\n    ${colors.dim(subtitle)}\n${colors.white(RAIL)}\n`;
}

export function formatPromptOutro(message: string, colors: PromptColors): string {
  const indented = message.replace(/\n/g, "\n   ");
  return `${colors.green(RAIL)}\n${colors.green("●")}  ${indented}\n`;
}

export function formatPromptCancellation(message: string, colors: PromptColors): string {
  const indented = message.replace(/\n/g, "\n   ");
  return `${colors.red(RAIL)}\n${colors.red("●")}  ${colors.red(indented)}\n`;
}

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

export function renderMultiselectPrompt<T extends PromptValue>(input: {
  colors: PromptColors;
  cursor: number;
  error?: string;
  footerNote?: string;
  leadingRail?: "white" | "green";
  message: string;
  helpText?: string;
  options: readonly PromptOption<T>[];
  selectedValues: readonly T[];
  state: PromptState;
  submitLabel?: string;
}): string {
  const rail = railFor(input.state, input.colors);
  const head = formatPromptHeader(input.state, input.message, {
    colors: input.colors,
    leadingRail: input.leadingRail,
  });
  const selectedSet = new Set(input.selectedValues);
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
      return `${head.trim()}\n${rail}  ${rows}${emptyNotice}${selectHelpText(input.helpText, rail, input.colors)}\n${cornerFor(input.state, input.colors)}  ${input.colors.red(input.error ?? "")}\n`;
    }
    case "initial":
    case "active": {
      const rows = renderMultiselectRows({ ...input, rail });
      const corner = cornerWithNote(cornerFor(input.state, input.colors), input.footerNote);
      return `${head}${rail}  ${rows}${emptyNotice}${selectHelpText(input.helpText, rail, input.colors)}\n${corner}\n`;
    }
  }
}

function selectHelpText(text: string | undefined, rail: string, colors: PromptColors): string {
  if (!text) return "";
  return `\n${rail}\n${text
    .split("\n")
    .map((line) => wrapTextWithPrefix(process.stdout, colors.dim(line), `${rail}  `))
    .join("\n")}\n${rail}`;
}

function cornerWithNote(corner: string, note: string | undefined): string {
  return note ? `${corner}  ${note}` : corner;
}

export function renderSelectPrompt<T extends PromptValue>(input: {
  colors: PromptColors;
  cursor: number;
  footerNote?: string;
  leadingRail?: "white" | "green";
  message: string;
  helpText?: string;
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
      return `${head}${rail}  ${rows}${selectHelpText(input.helpText, rail, input.colors)}\n${corner}\n`;
    }
  }
}

function labelColumnWidth<T extends PromptValue>(options: readonly PromptOption<T>[]): number {
  return options.reduce((width, option) => Math.max(width, option.label.length), 0);
}

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

function descriptionLine<T extends PromptValue>(
  option: PromptOption<T>,
  isCursor: boolean,
  rail: string,
  colors: PromptColors,
): string {
  return isCursor && option.description && !option.disabled
    ? `\n${rail}  ${renderOptionRowContinuation(colors.dim(option.description))}`
    : "";
}

function renderSubmitRow(
  isCursor: boolean,
  colors: PromptColors,
  label: string = "Submit",
): string {
  const bold = colors.bold(label);
  const content = isCursor
    ? `${UNICODE_ROW_GLYPHS.selectedPointer} ${bold}`
    : `  ${colors.dim(bold)}`;
  const suffixSeparator = " ";
  return `${renderCursorRow(content, isCursor, colors)}${suffixSeparator}${colors.green(UNICODE_ROW_GLYPHS.success)}`;
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

const SEARCHABLE_VIEW_SIZE = 8;

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

export function renderSearchableSelect<T extends PromptValue>(input: {
  colors: PromptColors;
  state: PromptState;
  leadingRail?: "white" | "green";
  message: string;
  multiple: boolean;
  helpText?: string;
  filter: string;
  placeholder?: string;
  options: readonly PromptOption<T>[];
  cursor: number;
  selectedValues: readonly T[];
  submitDisplay: string;
  footerNote?: string;
  error?: string;
  viewSize?: number;
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
  let featuredLead = 0;
  while (input.options[featuredLead]?.featured) featuredLead += 1;
  const baseViewSize = input.viewSize ?? SEARCHABLE_VIEW_SIZE;
  const viewSize =
    input.filter === "" && featuredLead > 0 ? Math.min(featuredLead, baseViewSize) : baseViewSize;
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
  const body = `${rail}  ${colors.dim(" ")} ${filterInput}\n${rail}  ${optionLines}${submitLine}${moreFooter}${selectHelpText(input.helpText, rail, colors)}${help}`;

  if (input.state === "error") {
    return `${head.trim()}\n${body}\n${cornerFor(input.state, colors)}  ${colors.red(input.error ?? "")}\n`;
  }
  const corner = cornerWithNote(cornerFor(input.state, colors), input.footerNote);
  return `${head}${body}\n${corner}\n`;
}
