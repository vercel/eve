/**
 * Alternate-screen mode for full-screen modal views (the `/traces` viewer).
 *
 * The dev TUI's transcript deliberately streams into native scrollback (see
 * `live-region.ts`), but a modal viewer wants the whole terminal without
 * fighting the transcript's repaint cycle. Entering the alternate buffer
 * gives the viewer a blank screen it fully owns; leaving restores the
 * transcript exactly where the user left it.
 *
 * Like {@link LiveRegion}, writes go through the terminal's original `write`
 * captured at construction so foreign-output capture never sees the paints.
 */

const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_TO_END = `${ESC}[0J`;
const CURSOR_HOME = `${ESC}[H`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

export interface AltScreenOutput {
  write(chunk: string): boolean;
}

export class AltScreen {
  readonly #write: (chunk: string) => boolean;
  #active = false;

  constructor(output: AltScreenOutput) {
    this.#write = output.write.bind(output);
  }

  get active(): boolean {
    return this.#active;
  }

  /** Switches to the alternate buffer, hides the cursor, enables SGR mouse. */
  enter(): void {
    if (this.#active) return;
    this.#write(`${ALT_SCREEN_ON}${HIDE_CURSOR}${MOUSE_ON}`);
    this.#active = true;
  }

  /**
   * Paints a full-screen frame. Each row must already be styled and fit
   * within the terminal width (one row == one screen line); rows beyond the
   * terminal height are dropped. The screen is erased before the rows are
   * written — terminals only erase via explicit sequences, so a shrinking
   * frame would otherwise leave stale text behind.
   *
   * Rows are placed with absolute cursor positions rather than `\n`: a row
   * filling the last column leaves terminals in an autowrap-pending state
   * whose interaction with `\n` varies (immediate-wrap terminals insert a
   * phantom line). Absolute positioning is immune to all of it.
   */
  paint(rows: readonly string[], height: number): void {
    if (!this.#active) return;
    const visible = rows.slice(0, Math.max(0, height));
    const body = visible.map((row, index) => `${ESC}[${index + 1}H${row}`).join("");
    this.#write(`${SYNC_START}${CURSOR_HOME}${CLEAR_TO_END}${body}${SYNC_END}`);
  }

  /** Restores the main screen, cursor, and mouse reporting. */
  exit(): void {
    if (!this.#active) return;
    this.#write(`${MOUSE_OFF}${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
    this.#active = false;
  }
}
