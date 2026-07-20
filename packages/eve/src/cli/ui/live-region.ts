/**
 * The inline scrollback engine.
 *
 * Unlike a full-screen alt-buffer UI, the dev TUI streams its transcript into
 * the terminal's *native* scrollback so the user keeps real scrolling, copy /
 * paste, and a persistent transcript after exit. Two regions are maintained:
 *
 * - **Committed scrollback** — finalized rows printed once and owned by the
 *   terminal thereafter (never repainted).
 * - **Live region** — the still-streaming rows plus the sticky footer, redrawn
 *   in place on every update.
 *
 * Redrawing moves the cursor to the top of the previous live region, clears to
 * the end of the screen, and reprints. {@link flush} additionally writes a run
 * of newly-finalized rows above the live region so they scroll away for good.
 *
 * Writes go through the terminal's original `write` captured at construction,
 * so the renderer's foreign-output capture (which monkeypatches
 * `process.stdout.write`) never mistakes the engine's own paint for agent log
 * output.
 */

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_TO_END = `${ESC}[0J`;
const CLEAR_SCREEN = `${ESC}[2J`;
const CLEAR_SCROLLBACK = `${ESC}[3J`;
const CURSOR_HOME = `${ESC}[H`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}[?2004l`;

export interface LiveRegionOutput {
  write(chunk: string): boolean;
}

export interface LiveRegionOptions {
  /** Wrap each paint in synchronized-update markers to avoid flicker. */
  synchronized?: boolean;
}

export class LiveRegion {
  readonly #write: (chunk: string) => boolean;
  readonly #synchronized: boolean;
  /** Rows the live region currently occupies on screen. */
  #liveRowCount = 0;

  constructor(output: LiveRegionOutput, options?: LiveRegionOptions) {
    this.#write = output.write.bind(output);
    this.#synchronized = options?.synchronized ?? true;
  }

  /** Hides the hardware cursor; the renderer draws its own caret. */
  hideCursor(): void {
    this.#write(HIDE_CURSOR);
  }

  showCursor(): void {
    this.#write(SHOW_CURSOR);
  }

  /** Toggles bracketed paste through the original write, bypassing foreign-output capture. */
  emitBracketedPaste(enabled: boolean): void {
    this.#write(enabled ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF);
  }

  /** Writes a newline through the bound (original) write. */
  newline(): void {
    this.#write("\n");
  }

  /**
   * Repaints the live region in place from `liveRows`. Each row must already
   * be styled and fit within the terminal width (one row == one screen line).
   */
  update(liveRows: readonly string[]): void {
    this.#paint([], liveRows);
  }

  /**
   * Commits `committedRows` to scrollback above the live region, then repaints
   * `liveRows`. Committed rows are permanent and scroll with the terminal.
   */
  flush(committedRows: readonly string[], liveRows: readonly string[]): void {
    this.#paint(committedRows, liveRows);
  }

  /**
   * Erases the live region, leaving the cursor at its former top. Committed
   * scrollback is untouched. Used on teardown before restoring the cursor.
   */
  clear(): void {
    if (this.#liveRowCount === 0) {
      this.#write("\r");
      this.#write(CLEAR_TO_END);
      return;
    }
    this.#write(`${this.#moveToTop()}${CLEAR_TO_END}`);
    this.#liveRowCount = 0;
  }

  /** Clears the visible transcript and, where supported, terminal scrollback. */
  clearAll(): void {
    this.#write(`${CLEAR_SCROLLBACK}${CLEAR_SCREEN}${CURSOR_HOME}`);
    this.#liveRowCount = 0;
  }

  /**
   * Forgets the live-region row count without moving the cursor. Call after
   * the cursor position is known to be a fresh column-0 line that the engine
   * did not itself paint (e.g. immediately after teardown).
   */
  reset(): void {
    this.#liveRowCount = 0;
  }

  #paint(committedRows: readonly string[], liveRows: readonly string[]): void {
    const body =
      this.#moveToTop() +
      CLEAR_TO_END +
      committedRows.map((row) => `${row}\n`).join("") +
      liveRows.join("\n");

    this.#write(this.#synchronized ? `${SYNC_START}${body}${SYNC_END}` : body);
    this.#liveRowCount = liveRows.length;
  }

  /**
   * Cursor sequence that returns to column 0 of the first live row. The cursor
   * sits at the end of the last live row after a paint, so move up
   * `liveRowCount - 1` lines. CPL (`F`) treats a 0 parameter as 1, so a single
   * (or empty) live region uses a bare carriage return instead.
   */
  #moveToTop(): string {
    if (this.#liveRowCount <= 1) {
      return "\r";
    }
    return `${ESC}[${this.#liveRowCount - 1}F`;
  }
}
