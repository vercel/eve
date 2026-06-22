import { Client } from "#client/index.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClient,
} from "#setup/verified-remote-client.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
} from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import type { DevelopmentTuiTarget } from "./target.js";
import type { TuiDisplayOptions } from "./types.js";

export type { DevelopmentTuiTarget } from "./target.js";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /**
   * Text to seed the prompt input with after the UI launches. The buffer is
   * editable and is not auto-submitted — the user presses Enter to send it.
   * Applies to the first prompt only.
   */
  readonly initialInput?: string;
  /** Reports local CLI boot phases. Omitted for remote and programmatic TUI runs. */
  readonly onBootProgress?: DevBootProgressReporter;
}

async function resolveClientOptions(
  target: DevelopmentTuiTarget,
): Promise<VerifiedRemoteDevelopmentClient> {
  if (target.kind === "local") {
    return {
      options: resolveDevelopmentClientOptions(target.serverUrl),
      lastOidcTokenFailure: () => undefined,
    };
  }

  return await resolveVerifiedRemoteDevelopmentClient({
    serverUrl: target.serverUrl,
    workspaceRoot: target.workspaceRoot,
  });
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
  const { target, initialInput, onBootProgress, ...display } = input;
  const { serverUrl } = target;

  const { options: clientOptions, lastOidcTokenFailure } = await resolveClientOptions(target);
  const client = new Client(clientOptions);

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler(
      target.kind === "local" ? { appRoot: target.workspaceRoot } : {},
    ),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatVercelAuthChallengeMessage({ serverUrl, oidcTokenFailure: lastOidcTokenFailure() })
        : toErrorMessage(error),
  };
  if (target.kind === "local") options.appRoot = target.workspaceRoot;
  if (initialInput !== undefined) options.initialInput = initialInput;
  if (onBootProgress !== undefined) options.onBootProgress = onBootProgress;

  await new EveTUIRunner(options).run();
}
