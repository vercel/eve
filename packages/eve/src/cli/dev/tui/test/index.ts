/**
 * Test-only entrypoint for driving the `eve dev` terminal UI from
 * TUI smoke tests. Consumed via `packages/eve/test/tui-client/lib/tui.ts`, which
 * imports the built output directly by path. Not part of the supported
 * public API — production code reaches the TUI through the internal
 * `#cli/dev/tui/*` modules instead.
 */
export { EveTUIRunner } from "../runner.js";
export type { EveTUIRunnerOptions } from "../runner.js";
export { createPromptCommandHandler } from "../prompt-command-handler.js";
export { TerminalRenderer } from "../terminal-renderer.js";
export { MockScreen, MockUserInput } from "./mock-terminal.js";
// The dev watcher's real log-line formatter, so smoke tests can drive the
// TUI's rebuild-status condensation with producer-authentic lines.
export {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  formatChangeDetectedLogLine,
} from "#internal/nitro/host/dev-watcher-log.js";
