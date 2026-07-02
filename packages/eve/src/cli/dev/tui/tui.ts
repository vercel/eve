import { Client } from "#client/index.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import {
  resolveLocalDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  resolveDevelopmentOidcToken,
  resolveLinkedDevelopmentOidcToken,
} from "#services/dev-client/request-headers.js";
import { isVercelAuthChallenge } from "#services/dev-client/vercel-auth-error.js";
import { resolveVercelDeployment } from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { promptCommandsFor } from "./prompt-commands.js";
import { formatRemoteAuthChallengeMessage } from "./remote-auth-result.js";
import { probeMcpConnection } from "./mcp-connection-status.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import { remoteHost, type DevelopmentTuiTarget, type RemoteDevelopmentTarget } from "./target.js";
import type { TuiDisplayOptions } from "./types.js";

export type { DevelopmentTuiTarget } from "./target.js";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /** Additional request headers sent by this TUI client. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Text to seed the prompt input with after the UI launches. A bare local
   * `/model` starts fresh-agent onboarding. Applies to the first prompt only.
   */
  readonly initialInput?: string;
  /** Reports local CLI boot phases. Omitted for remote and programmatic TUI runs. */
  readonly onBootProgress?: DevBootProgressReporter;
}

function prepareRemoteTarget(target: RemoteDevelopmentTarget) {
  const credentials = createDevelopmentCredentialGate(target.serverUrl);
  return {
    target,
    credentials,
    resolveOidcToken: resolveDevelopmentOidcToken,
    resolveDeployment: (signal: AbortSignal) =>
      resolveVercelDeployment({
        workspaceRoot: target.workspaceRoot,
        host: remoteHost(target),
        signal,
      }),
  } satisfies NonNullable<EveTUIRunnerOptions["remote"]>;
}

type PreparedDevelopmentTuiTarget =
  | {
      readonly kind: "local";
      readonly target: Extract<DevelopmentTuiTarget, { kind: "local" }>;
    }
  | {
      readonly kind: "remote";
      readonly target: RemoteDevelopmentTarget;
      readonly remote: NonNullable<EveTUIRunnerOptions["remote"]>;
    };

function prepareDevelopmentTarget(target: DevelopmentTuiTarget): PreparedDevelopmentTuiTarget {
  return target.kind === "local"
    ? { kind: "local", target }
    : { kind: "remote", target, remote: prepareRemoteTarget(target) };
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
  const { target, headers, initialInput, onBootProgress, ...display } = input;
  const prepared = prepareDevelopmentTarget(target);
  const { serverUrl } = target;
  const headerOptions = headers === undefined ? {} : { headers };

  const client = new Client(
    prepared.kind === "local"
      ? resolveLocalDevelopmentClientOptions({
          ...headerOptions,
          serverUrl,
          token: () => resolveLinkedDevelopmentOidcToken(prepared.target.workspaceRoot),
        })
      : resolveRemoteDevelopmentClientOptions({
          ...headerOptions,
          serverUrl,
          credentials: prepared.remote.credentials,
        }),
  );

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler({ target }),
    availablePromptCommands: promptCommandsFor(target.kind),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatRemoteAuthChallengeMessage(serverUrl)
        : toErrorMessage(error),
  };
  if (prepared.kind === "local") {
    options.appRoot = prepared.target.workspaceRoot;
    options.probeMcpConnection = probeMcpConnection;
  } else {
    options.remote = prepared.remote;
  }
  if (initialInput !== undefined) options.initialInput = initialInput;
  if (onBootProgress !== undefined) options.onBootProgress = onBootProgress;

  await new EveTUIRunner(options).run();
}
