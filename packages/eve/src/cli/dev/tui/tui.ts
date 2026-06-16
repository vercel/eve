import { Client } from "#client/index.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
} from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import type { TuiDisplayOptions } from "./types.js";

/**
 * Options for running the `eve dev` terminal UI against a server URL.
 */
export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /**
   * The eve server URL the TUI connects to — either the in-process dev
   * server started by `eve dev`, or a remote `--url` target.
   */
  readonly serverUrl: string;
  /**
   * Absolute application root. When present and the server is a local dev
   * server, enables the TUI's `/model` command to edit local agent source.
   * Omitted for remote (`--url`) targets.
   */
  readonly appRoot?: string;
  /**
   * Text to seed the prompt input with after the UI launches. The buffer is
   * editable and is not auto-submitted — the user presses Enter to send it.
   * Applies to the first prompt only.
   */
  readonly initialInput?: string;
}

/**
 * Runs the `eve dev` terminal UI against the given server URL until the
 * user exits.
 *
 * The configured client is handed to the runner so its subagent
 * child-session streams inherit the same auth. Turn-dispatch failures —
 * including the Vercel Deployment Protection challenge — are formatted into
 * the inline error region rather than crashing the command.
 */
export async function runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void> {
  const { serverUrl, appRoot, initialInput, ...display } = input;

  const client = new Client(resolveDevelopmentClientOptions(serverUrl));

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler({ appRoot }),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatVercelAuthChallengeMessage({ serverUrl })
        : toErrorMessage(error),
  };
  if (appRoot !== undefined) options.appRoot = appRoot;
  if (initialInput !== undefined) options.initialInput = initialInput;

  await new EveTUIRunner(options).run();
}
