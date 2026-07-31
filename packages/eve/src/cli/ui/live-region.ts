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

/**
 * Hardware-cursor park position within the live region, 0-based. Terminals
 * anchor the IME composition (pre-edit) overlay to the cursor *position*
 * regardless of its visibility, so parking the hidden cursor under the drawn
 * block caret makes uncommitted IME text render inline in the focused input
 * instead of at the frame's tail.
 */
export interface LiveCursor {
  /** Row within the live region (0 = first live row). */
  readonly row: number;
  /** Terminal column of the caret cell. */
  readonly column: number;
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
  /** Live-region row the hardware cursor was left on by the last write. */
  #cursorRow = 0;

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
   * When `cursor` is given, the (hidden) hardware cursor parks on that cell so
   * the terminal renders IME composition text at the focused input's caret.
   */
  update(liveRows: readonly string[], cursor?: LiveCursor): void {
    this.#paint([], liveRows, cursor);
  }

  /**
   * Commits `committedRows` to scrollback above the live region, then repaints
   * `liveRows`. Committed rows are permanent and scroll with the terminal.
   */
  flush(committedRows: readonly string[], liveRows: readonly string[], cursor?: LiveCursor): void {
    this.#paint(committedRows, liveRows, cursor);
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
    this.#cursorRow = 0;
  }

  /** Clears the visible transcript and, where supported, terminal scrollback. */
  clearAll(): void {
    this.#write(`${CLEAR_SCROLLBACK}${CLEAR_SCREEN}${CURSOR_HOME}`);
    this.#liveRowCount = 0;
    this.#cursorRow = 0;
  }

  /**
   * Forgets the live-region row count without moving the cursor. Call after
   * the cursor position is known to be a fresh column-0 line that the engine
   * did not itself paint (e.g. immediately after teardown).
   */
  reset(): void {
    this.#liveRowCount = 0;
    this.#cursorRow = 0;
  }

  #paint(committedRows: readonly string[], liveRows: readonly string[], cursor?: LiveCursor): void {
    const body =
      this.#moveToTop() +
      CLEAR_TO_END +
      committedRows.map((row) => `${row}\n`).join("") +
      liveRows.join("\n");

    this.#liveRowCount = liveRows.length;
    this.#cursorRow = Math.max(0, liveRows.length - 1);
    const park = cursor === undefined ? "" : this.#parkCursor(cursor);

    this.#write(this.#synchronized ? `${SYNC_START}${body}${park}${SYNC_END}` : `${body}${park}`);
  }

  /**
   * Cursor sequence that moves from the end of the freshly painted last live
   * row to the caret cell, so the terminal's IME overlay anchors to the
   * focused input. The cursor itself stays hidden — the renderer draws its
   * own caret; only the position matters here.
   */
  #parkCursor(cursor: LiveCursor): string {
    if (this.#liveRowCount === 0) return "";
    const row = Math.min(Math.max(0, cursor.row), this.#liveRowCount - 1);
    const column = Math.max(0, cursor.column);
    this.#cursorRow = row;
    // CPL (`F`) treats a 0 parameter as 1, so staying on the last row uses a
    // bare carriage return; CUF (`C`) likewise only fires for column > 0.
    const vertical =
      this.#liveRowCount - 1 - row > 0 ? `${ESC}[${this.#liveRowCount - 1 - row}F` : "\r";
    return column > 0 ? `${vertical}${ESC}[${column}C` : vertical;
  }

  /**
   * Cursor sequence that returns to column 0 of the first live row from
   * wherever the last paint left the hardware cursor (the end of the last
   * live row, or a parked caret cell). CPL (`F`) treats a 0 parameter as 1,
   * so a cursor already on the first row uses a bare carriage return.
   */
  #moveToTop(): string {
    if (this.#cursorRow <= 0) {
      return "\r";
    }
    return `${ESC}[${this.#cursorRow}F`;
  }
}
