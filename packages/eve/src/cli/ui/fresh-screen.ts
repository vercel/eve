import { isLogLevelEnabled } from "#internal/logging.js";

interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly rows?: number;
  write(chunk: string): unknown;
}

/** Moves the current viewport into scrollback before starting a new CLI session. */
export function startFreshScreen(output: TerminalOutput = process.stdout): void {
  const rows = output.rows;
  if (
    output.isTTY !== true ||
    process.env.CI ||
    process.env.TERM === "dumb" ||
    isLogLevelEnabled("debug") ||
    rows === undefined ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 1_000
  ) {
    return;
  }

  // Scrolling first preserves even the visible lines; an erase-screen alone does not.
  output.write(`\u001B[${rows};1H${"\n".repeat(rows)}\u001B[H`);
}
