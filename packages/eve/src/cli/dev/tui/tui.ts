import { Client } from "#client/index.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { appendUserAgentProduct } from "#internal/user-agent.js";
import type { CommandLifecycle } from "#cli/shutdown.js";
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
import { createDevDiagnostics, type DevDiagnostics } from "../diagnostics.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { promptCommandsFor } from "./prompt-commands.js";
import { pickAgentHeaderTip } from "./agent-header.js";
import { formatRemoteAuthChallengeMessage } from "./remote-auth-result.js";
import { probeMcpConnection } from "./mcp-connection-status.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import { remoteHost, type DevelopmentTuiTarget, type RemoteDevelopmentTarget } from "./target.js";
import type { TuiDisplayOptions } from "./types.js";

export type { DevelopmentTuiTarget } from "./target.js";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /** Additional request headers sent by this TUI client. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Text to seed the prompt input with after the UI launches. Applies to the first prompt only. */
  readonly initialInput?: string;
  /** Explicit fresh-agent onboarding handoff from `eve init`. */
  readonly initialOnboarding?: "agent";
  /** Reports local CLI boot phases. Omitted for remote and programmatic TUI runs. */
  readonly onBootProgress?: DevBootProgressReporter;
  /** Gives setup subprocesses exclusive terminal and development-host ownership. */
  withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly lifecycle?: CommandLifecycle;
  /** Prepared editing-only startup UI reused by the initialized local runner. */
  startup?: DevelopmentTuiStartup;
}

export interface DevelopmentTuiStartup {
  readonly diagnostics: DevDiagnostics | undefined;
  readonly headerTip: string;
  readonly renderer: TerminalRenderer;
  finish(): string;
  shutdown(): Promise<void>;
}

export async function startDevelopmentTuiStartup(
  input: TuiDisplayOptions & {
    readonly appRoot: string;
    readonly initialInput?: string;
    readonly onExitRequest: () => void;
  },
): Promise<DevelopmentTuiStartup> {
  const diagnostics = await createDevDiagnostics(input.appRoot).catch(() => undefined);
  const headerTip = pickAgentHeaderTip();
  const renderer = new TerminalRenderer({
    ...input,
    diagnostics,
    onExitRequest: input.onExitRequest,
  });
  renderer.beginStartupDraft({
    initialDraft: input.initialInput,
    tip: headerTip,
    title: input.name ?? "eve",
  });
  return {
    diagnostics,
    headerTip,
    renderer,
    finish: () => renderer.finishStartupDraft(),
    async shutdown() {
      renderer.shutdown();
      await diagnostics?.close();
    },
  };
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

function withTuiUserAgent(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const resolved = new Headers(headers);
  appendUserAgentProduct(resolved, `eve-tui/${resolveInstalledPackageInfo().version}`);
  return Object.fromEntries(resolved.entries());
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
  const {
    target,
    headers,
    initialInput,
    initialOnboarding,
    onBootProgress,
    lifecycle,
    startup,
    withExclusiveTerminal,
    ...display
  } = input;
  const prepared = prepareDevelopmentTarget(target);
  const { serverUrl } = target;
  const headerOptions = { headers: withTuiUserAgent(headers) };

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
  if (startup !== undefined) {
    options.renderer = startup.renderer;
    options.startup = startup;
  }
  if (initialOnboarding !== undefined) options.initialOnboarding = initialOnboarding;
  if (onBootProgress !== undefined) options.onBootProgress = onBootProgress;
  if (lifecycle !== undefined) options.lifecycle = lifecycle;
  if (withExclusiveTerminal !== undefined) options.withExclusiveTerminal = withExclusiveTerminal;

  const diagnostics =
    startup?.diagnostics ??
    (prepared.kind === "local"
      ? await createDevDiagnostics(prepared.target.workspaceRoot).catch(() => undefined)
      : undefined);
  if (diagnostics !== undefined) options.diagnostics = diagnostics;
  try {
    await new EveTUIRunner(options).run();
  } finally {
    await diagnostics?.close();
  }
}
