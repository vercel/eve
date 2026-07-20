/**
 * Visual language for the `eve dev` terminal UI.
 *
 * The palette and iconography follow the Vercel / Next.js CLI: a monochrome
 * base (bold white primary, dim gray secondary) anchored by the `▲` brand
 * mark, with restrained accent colors reserved for status — green `✓`, red
 * `⨯`, yellow `⚠`/spinner — and cyan for interactive/link text. Everything
 * here is pure string composition so blocks, the live region, and the agent
 * header can share one source of truth for glyphs and color.
 */

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

/**
 * Named color + emphasis formatters. Each wraps text in the matching SGR
 * sequence (or returns it untouched when color is disabled).
 */
export interface ThemeColors {
  reset: Style;
  bold: Style;
  dim: Style;
  /** Reverse video (SGR 7), used to draw the block caret over the character under it. */
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
  /** Vercel-orange accent (xterm-256 208), used for nested subagent regions. */
  orange: Style;
}

/**
 * Resolved glyphs for the current terminal (Unicode by default, ASCII when
 * the terminal can't be trusted with wide/box-drawing characters).
 */
export interface ThemeGlyphs {
  /** `▲` — the Vercel/eve brand mark; prefixes the agent's own output. */
  brand: string;
  /** `▌` — left gutter bar marking a user message. */
  user: string;
  /** `○` — reasoning / "thinking" marker (Next.js "wait" glyph). */
  reasoning: string;
  /** `✓` — a completed tool or success state. */
  success: string;
  /** `⨯` — an error or failed tool. */
  error: string;
  /** `⚠` — a warning / attention state. */
  warning: string;
  /** `◆` — a subagent region header. */
  subagent: string;
  /** `│` — vertical rule drawn in the gutter to nest subagent output. */
  rule: string;
  /** `?` — an interactive question awaiting an answer. */
  question: string;
  /** `●` — a connection awaiting authorization. */
  connection: string;
  /** `→` — separates a tool call from its summarized result. */
  arrow: string;
  /** `▷` — cursor marker for an inert option. */
  pointer: string;
  /** `▶` — cursor marker for an actionable option. */
  selectedPointer: string;
  /** `◦` — available, unselected option marker. */
  option: string;
  /** `❯` — the input prompt mark. */
  prompt: string;
  /** `⎿` — hangs a command's result under its invocation. */
  elbow: string;
  /** `▔` — strong full-width rule opening the bottom question panel. */
  hrule: string;
  /** `▏` — the synthetic input caret. */
  caret: string;
  /** `·` — inline separator for header / status segments. */
  dot: string;
  /** `…` — truncation marker. */
  ellipsis: string;
  /** `↑` — input (prompt) tokens in the token-flow segment. */
  arrowUp: string;
  /** `↓` — output (response) tokens in the token-flow segment. */
  arrowDown: string;
  /** `↯` — Fast mode (Gateway priority tier) marker beside a model id. */
  fast: string;
  /** `●` — a track notch below the current position (already covered). */
  trackFilled: string;
  /** `◉` — the track notch at the current position. */
  trackCurrent: string;
  /** `○` — a track notch above the current position. */
  trackEmpty: string;
  /** `─` — the connector segment between track notches. */
  trackLine: string;
  /** `↵` — the Enter affordance inside a selection badge. */
  enter: string;
  /** `▪` — the marker beside an in-flight validation badge. */
  validating: string;
}

const UNICODE_GLYPHS: ThemeGlyphs = {
  brand: "▲",
  user: "▌",
  reasoning: "○",
  success: "✓",
  error: "⨯",
  warning: "⚠",
  subagent: "◆",
  rule: "│",
  question: "?",
  connection: "●",
  arrow: "→",
  pointer: "▷",
  selectedPointer: "▶",
  option: "◦",
  prompt: "❯",
  elbow: "⎿",
  hrule: "▔",
  caret: "▏",
  dot: "·",
  ellipsis: "…",
  arrowUp: "↑",
  arrowDown: "↓",
  fast: "↯",
  trackFilled: "●",
  trackCurrent: "◉",
  trackEmpty: "○",
  trackLine: "─",
  enter: "↵",
  validating: "▪",
};

const ASCII_GLYPHS: ThemeGlyphs = {
  brand: ">",
  user: "|",
  reasoning: "o",
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
  caret: "_",
  dot: "-",
  ellipsis: "...",
  arrowUp: "^",
  arrowDown: "v",
  fast: ">>",
  trackFilled: "*",
  trackCurrent: "O",
  trackEmpty: ".",
  trackLine: "-",
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

export interface CreateThemeOptions {
  /** Whether to emit ANSI color. Defaults to `true`. */
  color?: boolean;
  /** Whether the terminal renders Unicode glyphs. Defaults to `true`. */
  unicode?: boolean;
}

/**
 * Builds the active {@link Theme}. Detection is intentionally left to the
 * caller (the renderer knows whether it owns a real TTY); this keeps the
 * theme a pure value that tests can construct deterministically.
 */
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

/**
 * Detects whether the host terminal can be trusted with Unicode glyphs.
 * Conservative: Windows legacy consoles and dumb terminals fall back to
 * ASCII. Honors an explicit override via `EVE_TUI_UNICODE=0|1`.
 */
export function detectUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.EVE_TUI_UNICODE;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;

  if (env.TERM === "dumb") return false;
  if (process.platform === "win32") {
    // Modern Windows Terminal / VS Code set these; legacy conhost does not.
    return Boolean(env.WT_SESSION || env.TERM_PROGRAM === "vscode");
  }
  return true;
}
