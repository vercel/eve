import { Client, ClientError, type AgentInfoResult } from "#client/index.js";
import type { DevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import {
  appendRemoteAuthMutationSummary,
  type RemoteAuthCompletedMutation,
  type RemoteAuthFlowFailure,
  type RemoteAuthPreparation,
} from "#setup/flows/remote-auth.js";
import type { VercelDeploymentResolution, VerifiedVercelTarget } from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";
import type { DeploymentIdentity } from "#shared/deployment-identity.js";
import { isObject } from "#shared/guards.js";

import { remoteHost, type RemoteDevelopmentTarget } from "./target.js";

export type RemoteAuthChallenge =
  | { readonly kind: "eve-oidc" }
  | { readonly kind: "vercel-deployment-protection" };

export type RemoteAuthFailure =
  | RemoteAuthFlowFailure
  | { readonly cause: "token-rejected"; readonly message: string };

export type RemoteRequestFailure =
  | {
      readonly cause: "http";
      readonly status: number;
      readonly code?: string;
      readonly message: string;
    }
  | {
      readonly cause: "invalid-response" | "network";
      readonly message: string;
    };

export type RemoteConnectionState =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly info: AgentInfoResult }
  | {
      readonly state: "auth-required";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "authenticating";
      readonly challenge: RemoteAuthChallenge;
      readonly trigger: "startup" | "command";
    }
  | {
      readonly state: "auth-failed";
      readonly challenge: RemoteAuthChallenge;
      readonly failure: RemoteAuthFailure;
    }
  | {
      readonly state: "unavailable";
      readonly failure: RemoteRequestFailure;
    };

export interface RemoteConnectionSnapshot {
  readonly target: RemoteDevelopmentTarget;
  readonly connection: RemoteConnectionState;
  /** Last deployment identity resolved from Vercel for this target. */
  readonly deployment?: DeploymentIdentity;
}

export type RemoteAuthCompletion =
  | { readonly kind: "authenticated"; readonly info: AgentInfoResult }
  | {
      readonly kind: "cancelled";
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "failed";
      readonly failure: RemoteAuthFailure;
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "unavailable";
      readonly failure: RemoteRequestFailure;
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    };

export interface RemoteConnectionController {
  current(): RemoteConnectionSnapshot;
  check(): Promise<RemoteConnectionState>;
  authenticate(
    trigger: "startup" | "command",
    prepare: (signal: AbortSignal) => Promise<RemoteAuthPreparation>,
    signal?: AbortSignal,
  ): Promise<RemoteAuthCompletion>;
  reportFailure(error: unknown): RemoteConnectionState;
  dispose(): void;
}

export interface RemoteConnectionControllerOptions {
  readonly client: Client;
  readonly credentials: DevelopmentCredentialGate;
  readonly target: RemoteDevelopmentTarget;
  /** Resolves an ambient token only after Vercel proves the exact target origin. */
  readonly resolveOidcToken?: () => Promise<string>;
  readonly resolveDeployment?: (signal: AbortSignal) => Promise<VercelDeploymentResolution>;
  readonly probeTimeoutMs?: number;
  readonly onChange: (snapshot: RemoteConnectionSnapshot) => void;
}

type RemoteProbeResult = Extract<
  RemoteConnectionState,
  { state: "ready" | "auth-required" | "unavailable" }
>;

function isEveOidcChallenge(error: unknown): boolean {
  if (!(error instanceof ClientError) || error.status !== 401) {
    return false;
  }

  try {
    const body: unknown = JSON.parse(error.body);
    return (
      isObject(body) &&
      body.ok === false &&
      body.code === "unauthorized" &&
      body.error === "Authorization is required for this route."
    );
  } catch {
    return false;
  }
}

function classifyRemoteError(
  error: unknown,
  phase: "connection-check" | "authentication-verification",
): RemoteProbeResult {
  if (isVercelAuthChallenge(error)) {
    return {
      state: "auth-required",
      challenge: { kind: "vercel-deployment-protection" },
    };
  }
  if (isEveOidcChallenge(error)) {
    return {
      state: "auth-required",
      challenge: { kind: "eve-oidc" },
    };
  }
  if (error instanceof ClientError) {
    const code = vercelTrustedSourcesErrorCode(error.message);
    if (
      phase === "connection-check" &&
      error.status === 403 &&
      code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"
    ) {
      return {
        state: "auth-required",
        challenge: { kind: "vercel-deployment-protection" },
      };
    }
    const failure = {
      cause: "http" as const,
      status: error.status,
      message: formatVercelTrustedSourcesFailure(error.message),
    };
    return {
      state: "unavailable",
      failure: code === undefined ? failure : { ...failure, code },
    };
  }
  if (error instanceof SyntaxError) {
    return {
      state: "unavailable",
      failure: {
        cause: "invalid-response",
        message: error.message,
      },
    };
  }
  return {
    state: "unavailable",
    failure: {
      cause: "network",
      message: toErrorMessage(error),
    },
  };
}

async function probeRemoteInfo(
  client: Client,
  phase: "connection-check" | "authentication-verification",
  signal: AbortSignal,
): Promise<RemoteProbeResult> {
  try {
    return { state: "ready", info: await client.info({ signal }) };
  } catch (error) {
    return classifyRemoteError(error, phase);
  }
}

const REMOTE_PROBE_TIMEOUT_MS = 10_000;

function probeSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`Remote connection check timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  timeout.unref();
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

function challengeFor(state: RemoteConnectionState): RemoteAuthChallenge {
  switch (state.state) {
    case "auth-required":
    case "authenticating":
    case "auth-failed":
      return state.challenge;
    case "checking":
    case "ready":
      return { kind: "eve-oidc" };
    case "unavailable":
      return state.failure.cause === "http" &&
        state.failure.code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"
        ? { kind: "vercel-deployment-protection" }
        : { kind: "eve-oidc" };
  }
}

export function createRemoteConnectionController(
  options: RemoteConnectionControllerOptions,
): RemoteConnectionController {
  let connection: RemoteConnectionState = { state: "checking" };
  let deployment: DeploymentIdentity | undefined;
  let operationAbort: AbortController | undefined;
  let operationGeneration = 0;
  let disposed = false;

  const snapshot = (): RemoteConnectionSnapshot =>
    deployment === undefined
      ? { target: options.target, connection }
      : { target: options.target, connection, deployment };
  const update = (next: RemoteConnectionState): RemoteConnectionState => {
    connection = next;
    if (!disposed) options.onChange(snapshot());
    return next;
  };
  const beginOperation = (
    parentSignal?: AbortSignal,
  ): { readonly generation: number; readonly signal: AbortSignal } => {
    operationAbort?.abort();
    const abort = new AbortController();
    const abortFromParent = (): void => abort.abort(parentSignal?.reason);
    if (parentSignal?.aborted === true) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    operationAbort = abort;
    return { generation: ++operationGeneration, signal: abort.signal };
  };
  const isCurrent = (generation: number): boolean =>
    !disposed && generation === operationGeneration;
  const publishTarget = (target: VerifiedVercelTarget): void => {
    deployment = target.deployment;
    if (!disposed) options.onChange(snapshot());
  };
  const authorizeResolvedTarget = async (
    signal: AbortSignal,
    generation: number,
  ): Promise<void> => {
    const resolveDeployment = options.resolveDeployment;
    if (resolveDeployment === undefined) return;
    try {
      const resolved = await resolveDeployment(signal);
      if (!isCurrent(generation) || signal.aborted || resolved.kind !== "resolved") return;
      publishTarget(resolved.target);
      options.credentials.authorize({
        target: resolved.target,
        resolveToken: options.resolveOidcToken ?? (async () => ""),
      });
    } catch {
      // Deployment metadata and ambient credentials are optional. The anonymous
      // probe below remains the authoritative connection result.
    }
  };
  const runProbe = async (
    phase: "connection-check" | "authentication-verification",
    parentSignal: AbortSignal,
  ): Promise<RemoteProbeResult> => {
    const timed = probeSignal(parentSignal, options.probeTimeoutMs ?? REMOTE_PROBE_TIMEOUT_MS);
    try {
      return await probeRemoteInfo(options.client, phase, timed.signal);
    } finally {
      timed.dispose();
    }
  };

  options.onChange(snapshot());

  return {
    current: snapshot,

    async check(): Promise<RemoteConnectionState> {
      const operation = beginOperation();
      update({ state: "checking" });
      await authorizeResolvedTarget(operation.signal, operation.generation);
      const probe = await runProbe("connection-check", operation.signal);
      if (!isCurrent(operation.generation)) return connection;
      const state = update(probe);
      return state;
    },

    async authenticate(
      trigger: "startup" | "command",
      prepare: (signal: AbortSignal) => Promise<RemoteAuthPreparation>,
      signal?: AbortSignal,
    ): Promise<RemoteAuthCompletion> {
      const operation = beginOperation(signal);
      const previous = connection;
      const challenge = challengeFor(connection);
      update({ state: "authenticating", challenge, trigger });

      let preparation: RemoteAuthPreparation;
      try {
        preparation = await prepare(operation.signal);
      } catch (error) {
        preparation = {
          kind: "failed",
          failure: {
            cause: "unexpected",
            message: toErrorMessage(error),
          },
          completedMutations: [],
        };
      }

      if (!isCurrent(operation.generation)) {
        return {
          kind: "cancelled",
          completedMutations: preparation.completedMutations,
        };
      }

      if (preparation.kind === "cancelled") {
        update(previous);
        return {
          kind: "cancelled",
          completedMutations: preparation.completedMutations,
        };
      }
      if (preparation.kind === "failed") {
        update({ state: "auth-failed", challenge, failure: preparation.failure });
        return {
          kind: "failed",
          failure: preparation.failure,
          completedMutations: preparation.completedMutations,
        };
      }
      if (operation.signal.aborted) {
        update(previous);
        return {
          kind: "cancelled",
          completedMutations: preparation.completedMutations,
        };
      }

      let restoreCredentials: () => void;
      try {
        restoreCredentials = options.credentials.authorize({
          target: preparation.target,
          resolveToken: preparation.resolveToken,
        });
      } catch (error) {
        const failure: RemoteAuthFailure = {
          cause: "unexpected",
          message: appendRemoteAuthMutationSummary(
            toErrorMessage(error),
            preparation.completedMutations,
          ),
        };
        update({ state: "auth-failed", challenge, failure });
        return {
          kind: "failed",
          failure,
          completedMutations: preparation.completedMutations,
        };
      }
      const verified = await runProbe("authentication-verification", operation.signal);
      if (!isCurrent(operation.generation)) {
        restoreCredentials();
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (operation.signal.aborted) {
        restoreCredentials();
        update(previous);
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (verified.state === "ready") {
        publishTarget(preparation.target);
        update(verified);
        return { kind: "authenticated", info: verified.info };
      }
      restoreCredentials();
      if (verified.state === "auth-required") {
        const failure: RemoteAuthFailure = {
          cause: "token-rejected",
          message: appendRemoteAuthMutationSummary(
            `The selected Vercel project did not authorize ${remoteHost(options.target)}.`,
            preparation.completedMutations,
          ),
        };
        update({ state: "auth-failed", challenge: verified.challenge, failure });
        return {
          kind: "failed",
          failure,
          completedMutations: preparation.completedMutations,
        };
      }
      if (verified.state === "unavailable") {
        const failure = {
          ...verified.failure,
          message: appendRemoteAuthMutationSummary(
            verified.failure.message,
            preparation.completedMutations,
          ),
        };
        update({ state: "unavailable", failure });
        return {
          kind: "unavailable",
          failure,
          completedMutations: preparation.completedMutations,
        };
      }

      const exhaustive: never = verified;
      return exhaustive;
    },

    reportFailure(error: unknown): RemoteConnectionState {
      operationAbort?.abort();
      operationGeneration += 1;
      return update(classifyRemoteError(error, "connection-check"));
    },

    dispose(): void {
      disposed = true;
      operationGeneration += 1;
      operationAbort?.abort();
      operationAbort = undefined;
    },
  };
}
