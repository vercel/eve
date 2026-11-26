import type { EveCliSetupStepEvent, EveCliSetupTerminalEvent } from "#cli/telemetry/index.js";
import { Client } from "#client/index.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { appendUserAgentProduct } from "#internal/user-agent.js";
import type { CommandLifecycle } from "#cli/shutdown.js";
import {
  hasDevelopmentAuthorizationHeader,
  resolveLocalDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { signInToAgent } from "#cli/dev/agent-oauth.js";
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
import { createDevDiagnostics } from "../diagnostics.js";
import { inlineArgumentSuggestions, type DevelopmentTuiStartup } from "./startup.js";
import type { StartupOnboardingResult } from "./startup-onboarding.js";
import { remoteHost, type DevelopmentTuiTarget, type RemoteDevelopmentTarget } from "./target.js";
import type { TuiDisplayOptions } from "./types.js";

export type { DevelopmentTuiTarget } from "./target.js";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  readonly target: DevelopmentTuiTarget;
  readonly headers?: Readonly<Record<string, string>>;
  readonly initialInput?: string;
  readonly viewSessionId?: string;
  readonly onboard?: boolean;
  readonly onOnboardingStep?: (input: EveCliSetupStepEvent) => void;
  readonly onOnboardingTerminal?: (input: EveCliSetupTerminalEvent) => void;
  readonly onBootProgress?: DevBootProgressReporter;
  withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly lifecycle?: CommandLifecycle;
  startup?: DevelopmentTuiStartup;
  startupOnboarding?: StartupOnboardingResult;
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

export async function runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void> {
  const {
    target,
    headers,
    initialInput,
    viewSessionId,
    onboard,
    onOnboardingStep,
    onOnboardingTerminal,
    onBootProgress,
    lifecycle,
    startup,
    startupOnboarding,
    withExclusiveTerminal,
    ...display
  } = input;
  const prepared = prepareDevelopmentTarget(target);
  const { serverUrl } = target;
  const headerOptions = { headers: withTuiUserAgent(headers) };
  const agentOAuth =
    prepared.kind === "remote" && !hasDevelopmentAuthorizationHeader(headers)
      ? await signInToAgent({
          ...(headers !== undefined && { headers }),
          notice: (message) => process.stdout.write(`${message}\n`),
          serverUrl,
          ...(lifecycle !== undefined && { signal: lifecycle.signal }),
        })
      : undefined;

  const client = new Client(
    agentOAuth !== undefined
      ? {
          ...headerOptions,
          auth: { bearer: () => agentOAuth.token() },
          baseUrl: serverUrl,
          redirect: "manual",
        }
      : prepared.kind === "local"
        ? resolveLocalDevelopmentClientOptions({
            ...headerOptions,
            interactiveClient: true,
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
    ...(target.kind === "local"
      ? { argumentSuggestions: inlineArgumentSuggestions(target.workspaceRoot) }
      : {}),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatRemoteAuthChallengeMessage(serverUrl)
        : toErrorMessage(error),
  };
  if (prepared.kind === "local") {
    options.appRoot = prepared.target.workspaceRoot;
    options.probeMcpConnection = probeMcpConnection;
  } else if (agentOAuth === undefined) {
    options.remote = prepared.remote;
  }
  if (initialInput !== undefined) options.initialInput = initialInput;
  if (viewSessionId !== undefined) options.viewSessionId = viewSessionId;
  if (startup !== undefined) {
    options.renderer = startup.renderer;
    options.startup = startup;
  }
  if (onboard !== undefined) options.onboard = onboard;
  if (startupOnboarding !== undefined) options.startupOnboarding = startupOnboarding;
  if (onOnboardingStep !== undefined) options.onOnboardingStep = onOnboardingStep;
  if (onOnboardingTerminal !== undefined) options.onOnboardingTerminal = onOnboardingTerminal;
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
