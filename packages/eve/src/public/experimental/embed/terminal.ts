/**
 * Experimental: `eve dev`'s terminal UI for an agent from `eve/experimental/embed`, served in this
 * process. Its own entry, so a program that only runs sessions doesn't load the TUI. APIs may
 * change without notice.
 */
export { runTerminal, type TerminalOptions } from "#embed/terminal.js";
