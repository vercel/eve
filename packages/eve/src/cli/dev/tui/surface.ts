import type { TerminalKey } from "./stream-format.js";

/** Settles one surface's question; either call takes the surface off the stack. */
export interface Settle<T> {
  done(value: T): void;
  fail(error: unknown): void;
}

/**
 * Something that takes the keyboard on top of the composer: an approval, a
 * question, a setup prompt, a panel, or a key trap. The top surface gets
 * every key; `rows` says what it paints.
 */
export interface Surface {
  key(key: TerminalKey): void;
  /**
   * Where the rows paint: `drawer` rows replace the composer and keep the task
   * panel above them, `panel` rows replace the whole footer, and `flow` rows
   * paint inside the open setup flow. Key traps paint nothing.
   */
  readonly placement?: "drawer" | "panel" | "flow";
  rows?(width: number): string[];
  /** Whether a text caret blinks while this surface is on top. */
  caret?(): boolean;
  dispose?(): void;
}

/** Pushes a surface and resolves with its answer; `onStop` answers when the TUI closes first. */
export type AskSurface = <T>(make: (settle: Settle<T>) => Surface, onStop?: () => T) => Promise<T>;
