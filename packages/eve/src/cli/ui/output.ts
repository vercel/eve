import picocolors from "#compiled/picocolors/index.js";

type CliMessageTone =
  | "accent"
  | "danger"
  | "default"
  | "info"
  | "muted"
  | "subagent"
  | "success"
  | "warning";

/**
 * Shared color palette used by the eve CLI.
 */
export interface CliTheme {
  readonly color: boolean;
  accent(text: string): string;
  danger(text: string): string;
  heading(text: string): string;
  info(text: string): string;
  label(text: string): string;
  muted(text: string): string;
  plain(text: string): string;
  subagent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
}

/**
 * One labeled value rendered inside a CLI section.
 */
export interface CliRow {
  readonly label: string;
  readonly tone?: CliMessageTone;
  readonly value: string;
}

const terminalEscapeCodePoint = 0x1b;
const bellCodePoint = 0x07;
const stringTerminatorCodePoint = 0x9c;

export function sanitizeForTerminal(input: string): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    const codePoint = input.codePointAt(index);

    if (codePoint == null) {
      break;
    }

    if (codePoint === terminalEscapeCodePoint) {
      index = skipEscSequence({ start: index, value: input });
      continue;
    }

    if (codePoint === 0x9b) {
      index = skipCsiSequence({ start: index + 1, value: input });
      continue;
    }

    if (isC1StringControlCodePoint(codePoint)) {
      index = skipStringControlSequence({ start: index + 1, value: input });
      continue;
    }

    const character = String.fromCodePoint(codePoint);
    index += character.length;

    if (isUnsafeControlCodePoint(codePoint)) {
      continue;
    }

    output += character;
  }

  return output;
}

function applyTone(theme: CliTheme, tone: CliMessageTone, value: string): string {
  switch (tone) {
    case "accent":
      return theme.accent(value);
    case "danger":
      return theme.danger(value);
    case "info":
      return theme.info(value);
    case "muted":
      return theme.muted(value);
    case "subagent":
      return theme.subagent(value);
    case "success":
      return theme.success(value);
    case "warning":
      return theme.warning(value);
    default:
      return theme.plain(value);
  }
}

function renderIndentedLines(lines: readonly string[], indent: string): string[] {
  const [firstLine = "", ...rest] = lines;

  return [firstLine, ...rest.map((line) => `${indent}${line}`)];
}

function skipEscSequence(input: { readonly start: number; readonly value: string }): number {
  const nextIndex = input.start + 1;
  const nextCodePoint = input.value.codePointAt(nextIndex);

  if (nextCodePoint == null) {
    return nextIndex;
  }

  if (nextCodePoint === 0x5b) {
    return skipCsiSequence({ start: nextIndex + 1, value: input.value });
  }

  if (isEscStringControlIntroducer(nextCodePoint)) {
    return skipStringControlSequence({ start: nextIndex + 1, value: input.value });
  }

  const nextCharacter = String.fromCodePoint(nextCodePoint);

  if (isCharsetDesignationIntroducer(nextCodePoint)) {
    const designationIndex = nextIndex + nextCharacter.length;
    const designationCodePoint = input.value.codePointAt(designationIndex);

    if (designationCodePoint == null) {
      return designationIndex;
    }

    return designationIndex + String.fromCodePoint(designationCodePoint).length;
  }

  return nextIndex + nextCharacter.length;
}

function skipCsiSequence(input: { readonly start: number; readonly value: string }): number {
  let index = input.start;

  while (index < input.value.length) {
    const codePoint = input.value.codePointAt(index);

    if (codePoint == null) {
      break;
    }

    const character = String.fromCodePoint(codePoint);
    index += character.length;

    if (codePoint >= 0x40 && codePoint <= 0x7e) {
      return index;
    }
  }

  return index;
}

function skipStringControlSequence(input: {
  readonly start: number;
  readonly value: string;
}): number {
  let index = input.start;

  while (index < input.value.length) {
    const codePoint = input.value.codePointAt(index);

    if (codePoint == null) {
      break;
    }

    const character = String.fromCodePoint(codePoint);
    const nextIndex = index + character.length;

    if (codePoint === bellCodePoint || codePoint === stringTerminatorCodePoint) {
      return nextIndex;
    }

    if (codePoint === terminalEscapeCodePoint && input.value.codePointAt(nextIndex) === 0x5c) {
      return nextIndex + 1;
    }

    index = nextIndex;
  }

  return index;
}

function isEscStringControlIntroducer(codePoint: number): boolean {
  return (
    codePoint === 0x50 ||
    codePoint === 0x58 ||
    codePoint === 0x5d ||
    codePoint === 0x5e ||
    codePoint === 0x5f
  );
}

function isC1StringControlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x90 ||
    codePoint === 0x98 ||
    codePoint === 0x9d ||
    codePoint === 0x9e ||
    codePoint === 0x9f
  );
}

function isCharsetDesignationIntroducer(codePoint: number): boolean {
  return (
    codePoint === 0x28 ||
    codePoint === 0x29 ||
    codePoint === 0x2a ||
    codePoint === 0x2b ||
    codePoint === 0x2d ||
    codePoint === 0x2e ||
    codePoint === 0x2f
  );
}

function isUnsafeControlCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function renderOrangeText(input: { color: boolean; text: string }): string {
  if (!input.color) {
    return input.text;
  }

  return `\u001B[38;5;208m${input.text}\u001B[39m`;
}

/**
 * Creates the theme used by CLI commands and the interactive REPL.
 */
export function createCliTheme(input: { color?: boolean } = {}): CliTheme {
  const colors = picocolors.createColors(input.color ?? Boolean(process.stdout.isTTY));

  return {
    accent: (text) => colors.cyan(text),
    color: colors.isColorSupported,
    danger: (text) => colors.red(text),
    heading: (text) => colors.bold(colors.cyan(text)),
    info: (text) => colors.blue(text),
    label: (text) => colors.bold(text),
    muted: (text) => colors.dim(text),
    plain: (text) => text,
    subagent: (text) => renderOrangeText({ color: colors.isColorSupported, text }),
    success: (text) => colors.green(text),
    warning: (text) => colors.yellow(text),
  };
}

/**
 * Renders a CLI banner with an optional subtitle.
 */
export function renderCliBanner(
  theme: CliTheme,
  input: {
    readonly subtitle?: string;
    readonly title: string;
  },
): string {
  const title = sanitizeForTerminal(input.title);
  const lines = [theme.heading(title), theme.muted("=".repeat(title.length))];

  if (input.subtitle) {
    lines.push(theme.muted(sanitizeForTerminal(input.subtitle)));
  }

  return lines.join("\n");
}

/**
 * Renders one labeled section with aligned values.
 */
export function renderCliSection(
  theme: CliTheme,
  input: {
    readonly rows: readonly CliRow[];
    readonly title: string;
  },
): string {
  const rows = input.rows.map((row) => ({
    label: sanitizeForTerminal(row.label),
    tone: row.tone,
    value: sanitizeForTerminal(row.value),
  }));
  const labelWidth = rows.reduce((width, row) => Math.max(width, row.label.length), 0);
  const lines = [theme.accent(sanitizeForTerminal(input.title))];

  for (const row of rows) {
    const valueLines = renderIndentedLines(
      applyTone(theme, row.tone ?? "default", row.value).split("\n"),
      `${" ".repeat(labelWidth)}  `,
    );
    const [firstLine = "", ...rest] = valueLines;

    lines.push(`${theme.label(row.label.padEnd(labelWidth))}  ${firstLine}`);
    lines.push(...rest);
  }

  return lines.join("\n");
}

/**
 * Renders one prefixed line used by the interactive dev REPL.
 */
export function renderCliTaggedLine(
  theme: CliTheme,
  input: {
    readonly message: string;
    readonly tag: string;
    readonly tone?: CliMessageTone;
  },
): string {
  const message = sanitizeForTerminal(input.message);
  const prefix = `[${sanitizeForTerminal(input.tag).toUpperCase()}]`;
  const valueLines = renderIndentedLines(
    applyTone(theme, input.tone ?? "default", message).split("\n"),
    `${" ".repeat(prefix.length)} `,
  );
  const [firstLine = "", ...rest] = valueLines;

  return (
    [theme.muted(prefix), firstLine].join(" ") + (rest.length > 0 ? `\n${rest.join("\n")}` : "")
  );
}

/**
 * Renders one speaker-prefixed line such as `agent>`.
 */
export function renderCliSpeakerLine(
  theme: CliTheme,
  input: {
    readonly message: string;
    readonly speaker: string;
    readonly tone?: CliMessageTone;
  },
): string {
  const message = sanitizeForTerminal(input.message);
  const prefix = `${sanitizeForTerminal(input.speaker)}>`;
  const valueLines = renderIndentedLines(
    applyTone(theme, input.tone ?? "default", message).split("\n"),
    `${" ".repeat(prefix.length)} `,
  );
  const [firstLine = "", ...rest] = valueLines;

  return (
    [theme.muted(prefix), firstLine].join(" ") + (rest.length > 0 ? `\n${rest.join("\n")}` : "")
  );
}
