/**
 * Alternate-screen mode for temporary full-screen terminal ownership.
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

import type { TerminalWriteTarget } from "#cli/ui/ansi.js";
import {
  CLEAR_TO_END,
  CURSOR_HOME,
  ESC,
  HIDE_CURSOR,
  SHOW_CURSOR,
  SYNC_END,
  SYNC_START,
} from "#cli/ui/ansi.js";

const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
// 1002 (button-event tracking) reports motion while a button is held, which
// drag-to-select needs; 1006 upgrades coordinates to the SGR encoding.
const MOUSE_ON = `${ESC}[?1002h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l`;

export interface AltScreenEnterOptions {
  /** Interactive subprocesses need the terminal cursor; rendered views do not. */
  cursor?: "hidden" | "visible";
  /** Rendered views use mouse events; inherited subprocesses retain native selection. */
  mouse?: boolean;
}

export class AltScreen {
  readonly #write: (chunk: string) => boolean;
  #active = false;
  #mouse = false;

  constructor(output: TerminalWriteTarget) {
    this.#write = output.write.bind(output);
  }

  get active(): boolean {
    return this.#active;
  }

  /** Switches to the alternate buffer with view-friendly defaults. */
  enter(options: AltScreenEnterOptions = {}): void {
    if (this.#active) return;
    const mouse = options.mouse ?? true;
    const cursor = options.cursor ?? "hidden";
    this.#write(
      `${ALT_SCREEN_ON}${cursor === "hidden" ? HIDE_CURSOR : SHOW_CURSOR}${mouse ? MOUSE_ON : ""}`,
    );
    this.#mouse = mouse;
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

  /**
   * Writes an out-of-band sequence (e.g. an OSC 52 clipboard write) through
   * the same captured write the paints use, bypassing foreign-output capture.
   */
  writeRaw(chunk: string): void {
    if (!this.#active) return;
    this.#write(chunk);
  }

  /** Restores the main screen, cursor, and mouse reporting. */
  exit(): void {
    if (!this.#active) return;
    this.#write(`${this.#mouse ? MOUSE_OFF : ""}${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
    this.#mouse = false;
    this.#active = false;
  }
}
