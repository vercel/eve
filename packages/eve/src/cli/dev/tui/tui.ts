import { Client } from "#client/index.js";
import {
  resolveDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
} from "#services/dev-client/vercel-auth-error.js";
import { resolveVercelDeployment } from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { promptCommandsFor } from "./prompt-commands.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import type { TuiSetupCommandTarget } from "./setup-commands.js";
import type { TuiDisplayOptions } from "./types.js";

/**
 * Options for running the `eve dev` terminal UI against a server URL.
 */
export type DevelopmentTuiTarget =
  | {
      readonly kind: "local";
      readonly serverUrl: string;
      readonly appRoot: string;
    }
  | {
      readonly kind: "remote";
      readonly serverUrl: string;
      readonly workspaceRoot: string;
    };

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /**
   * Text to seed the prompt input with after the UI launches. The buffer is
   * editable and is not auto-submitted — the user presses Enter to send it.
   * Applies to the first prompt only.
   */
  readonly initialInput?: string;
}

function prepareRemoteTarget(target: Extract<DevelopmentTuiTarget, { kind: "remote" }>) {
  const host = new URL(target.serverUrl).host;
  const credentials = createDevelopmentCredentialGate(target.serverUrl);
  const remote = {
    target: {
      serverUrl: target.serverUrl,
      host,
      workspaceRoot: target.workspaceRoot,
    },
    credentials,
    resolveOidcToken: resolveDevelopmentOidcToken,
    resolveDeployment: (signal: AbortSignal) =>
      resolveVercelDeployment({ workspaceRoot: target.workspaceRoot, host, signal }),
  } satisfies NonNullable<EveTUIRunnerOptions["remote"]>;
  return { kind: "remote" as const, serverUrl: target.serverUrl, remote };
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
  const { target, initialInput, ...display } = input;
  const preparedTarget = target.kind === "remote" ? prepareRemoteTarget(target) : target;
  const { serverUrl } = preparedTarget;

  const client = new Client(
    preparedTarget.kind === "local"
      ? resolveDevelopmentClientOptions(serverUrl)
      : resolveRemoteDevelopmentClientOptions({
          serverUrl,
          credentials: preparedTarget.remote.credentials,
        }),
  );
  const commandTarget: TuiSetupCommandTarget =
    preparedTarget.kind === "local"
      ? { kind: "local", appRoot: preparedTarget.appRoot }
      : {
          kind: "remote",
          ...preparedTarget.remote.target,
        };

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler({ target: commandTarget }),
    availablePromptCommands: promptCommandsFor(preparedTarget.kind),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatVercelAuthChallengeMessage({ serverUrl })
        : toErrorMessage(error),
  };
  if (preparedTarget.kind === "local") {
    options.appRoot = preparedTarget.appRoot;
  } else {
    options.remote = preparedTarget.remote;
  }
  if (initialInput !== undefined) options.initialInput = initialInput;

  await new EveTUIRunner(options).run();
}
