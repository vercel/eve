/**
 * Terminal control sequences shared by the two painting engines: the inline
 * scrollback engine (`live-region.ts`) and the alternate-screen viewer
 * (`alt-screen.ts`). Sequences used by only one of them stay in that module.
 */

export const ESC = "\x1b";

export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
/** Erases from the cursor to the end of the screen. */
export const CLEAR_TO_END = `${ESC}[0J`;
export const CURSOR_HOME = `${ESC}[H`;
/** Synchronized-update markers: the terminal presents the frame atomically. */
export const SYNC_START = `${ESC}[?2026h`;
export const SYNC_END = `${ESC}[?2026l`;

/**
 * A terminal's own `write`, captured at construction so the renderer's
 * foreign-output capture (which monkeypatches `process.stdout.write`) never
 * mistakes an engine's own paint for agent log output.
 */
export interface TerminalWriteTarget {
  write(chunk: string): boolean;
}
