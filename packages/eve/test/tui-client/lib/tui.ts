/**
 * Local access point for the `eve dev` terminal-UI test harness used by the
 * `tui-*.ts` smoke tests. The harness is test infrastructure, not part of
 * eve's public API, so it is intentionally absent from the package's
 * `exports` map; TUI smoke tests reach the built file directly by path instead.
 *
 * Requires `pnpm run build:js` to have produced `packages/eve/dist` first.
 */
export {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  EveTUIRunner,
  createPromptCommandHandler,
  promptCommandsFor,
  type EveTUIRunnerOptions,
  formatChangeDetectedLogLine,
  MockScreen,
  MockUserInput,
  TerminalRenderer,
} from "../../../dist/src/cli/dev/tui/test/index.js";
