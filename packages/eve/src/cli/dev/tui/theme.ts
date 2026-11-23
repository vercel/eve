const ESC = "\x1b[";

type Style = (text: string) => string;

function ansi(open: number, close: number, enabled: boolean): Style {
  if (!enabled) {
    return (text) => text;
  }
  const prefix = `${ESC}${open}m`;
  const suffix = `${ESC}${close}m`;
  return (text) => `${prefix}${text}${suffix}`;
}

function ansi256(code: number, enabled: boolean): Style {
  if (!enabled) {
    return (text) => text;
  }
  const prefix = `${ESC}38;5;${code}m`;
  const suffix = `${ESC}39m`;
  return (text) => `${prefix}${text}${suffix}`;
}

export interface ThemeColors {
  reset: Style;
  bold: Style;
  dim: Style;
  inverse: Style;
  italic: Style;
  white: Style;
  gray: Style;
  cyan: Style;
  green: Style;
  red: Style;
  yellow: Style;
  magenta: Style;
  blue: Style;
  orange: Style;
}

export interface ThemeGlyphs {
  brand: string;
  user: string;
  reasoning: string;
  square: string;
  corner: string;
  cornerOpen: string;
  external: string;
  dotActive: string;
  success: string;
  error: string;
  warning: string;
  subagent: string;
  rule: string;
  question: string;
  connection: string;
  arrow: string;
  pointer: string;
  selectedPointer: string;
  option: string;
  prompt: string;
  elbow: string;
  hrule: string;
  dash: string;
  caret: string;
  dot: string;
  ellipsis: string;
  arrowUp: string;
  arrowDown: string;
  fast: string;
  enter: string;
  validating: string;
}

const UNICODE_GLYPHS: ThemeGlyphs = {
  brand: "▲",
  user: "│",
  reasoning: "○",
  square: "▪",
  corner: "└",
  cornerOpen: "┌",
  external: "⌝",
  dotActive: "⏺",
  success: "✓",
  error: "⨯",
  warning: "⚠",
  subagent: "※",
  rule: "│",
  question: "?",
  connection: "●",
  arrow: "→",
  pointer: "›",
  selectedPointer: "›",
  option: " ",
  prompt: "❯",
  elbow: "⎿",
  hrule: "▔",
  dash: "─",
  caret: "▏",
  dot: "·",
  ellipsis: "…",
  arrowUp: "↑",
  arrowDown: "↓",
  fast: "⚡",
  enter: "↵",
  validating: "▪",
};

const ASCII_GLYPHS: ThemeGlyphs = {
  brand: ">",
  user: "|",
  reasoning: "o",
  square: "*",
  corner: "`",
  cornerOpen: ",",
  external: "^",
  dotActive: "*",
  success: "+",
  error: "x",
  warning: "!",
  subagent: "*",
  rule: "|",
  question: "?",
  connection: "*",
  arrow: "->",
  pointer: ">",
  selectedPointer: ">",
  option: ".",
  prompt: ">",
  elbow: "`-",
  hrule: "=",
  dash: "-",
  caret: "_",
  dot: "-",
  ellipsis: "...",
  arrowUp: "^",
  arrowDown: "v",
  fast: ">>",
  enter: "<-'",
  validating: "o",
};

const UNICODE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_SPINNER = ["-", "\\", "|", "/"];

export interface Theme {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly colors: ThemeColors;
  readonly glyph: ThemeGlyphs;
  readonly spinner: readonly string[];
}

interface CreateThemeOptions {
  color?: boolean;
  unicode?: boolean;
}

export function createTheme(options: CreateThemeOptions = {}): Theme {
  const color = options.color ?? true;
  const unicode = options.unicode ?? true;

  return {
    color,
    unicode,
    colors: {
      reset: ansi(0, 0, color),
      bold: ansi(1, 22, color),
      dim: ansi(2, 22, color),
      inverse: ansi(7, 27, color),
      italic: ansi(3, 23, color),
      white: ansi(97, 39, color),
      gray: ansi(90, 39, color),
      cyan: ansi(36, 39, color),
      green: ansi(32, 39, color),
      red: ansi(31, 39, color),
      yellow: ansi(33, 39, color),
      magenta: ansi(35, 39, color),
      blue: ansi(34, 39, color),
      orange: ansi256(208, color),
    },
    glyph: unicode ? UNICODE_GLYPHS : ASCII_GLYPHS,
    spinner: unicode ? UNICODE_SPINNER : ASCII_SPINNER,
  };
}

export function detectUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.EVE_TUI_UNICODE;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;

  if (env.TERM === "dumb") return false;
  if (process.platform === "win32") {
    return Boolean(env.WT_SESSION || env.TERM_PROGRAM === "vscode");
  }
  return true;
}
