import type { ResolvedVercelDeployment, VerifiedVercelTarget } from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";

import {
  appendRemoteAuthMutationSummary,
  type RemoteAuthPreparation,
} from "./remote-auth-result.js";
import { classifyRemoteError, probeRemoteInfo } from "./remote-connection-probe.js";
import type {
  RemoteAuthChallenge,
  RemoteAuthCompletion,
  RemoteConnectionController,
  RemoteConnectionControllerOptions,
  RemoteConnectionSnapshot,
  RemoteConnectionState,
} from "./remote-connection-types.js";
import { remoteHost } from "./target.js";

export type {
  RemoteAuthChallenge,
  RemoteAuthCompletion,
  RemoteConnectionController,
  RemoteConnectionControllerOptions,
  RemoteConnectionSnapshot,
  RemoteConnectionState,
} from "./remote-connection-types.js";

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
      return state.failure.code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"
        ? { kind: "vercel-deployment-protection" }
        : { kind: "eve-oidc" };
  }
}

export function createRemoteConnectionController(
  options: RemoteConnectionControllerOptions,
): RemoteConnectionController {
  let connection: RemoteConnectionState = { state: "checking" };
  let deployment: ResolvedVercelDeployment | undefined;
  let operationAbort: AbortController | undefined;
  let restoreActiveCredentials: (() => void) | undefined;
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
    operationAbort = abort;
    const signal =
      parentSignal === undefined ? abort.signal : AbortSignal.any([abort.signal, parentSignal]);
    return { generation: ++operationGeneration, signal };
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
  ): Promise<(() => void) | undefined> => {
    const resolveDeployment = options.resolveDeployment;
    if (resolveDeployment === undefined) return;
    try {
      const resolved = await resolveDeployment(signal);
      if (!isCurrent(generation) || signal.aborted || resolved.kind !== "resolved") return;
      publishTarget(resolved.target);
      const resolveToken = async () =>
        (await options.resolveOidcToken?.(resolved.target.deployment)) ?? "";
      return options.credentials.authorize({ target: resolved.target, resolveToken });
    } catch {
      // Deployment metadata and ambient credentials are optional. The anonymous
      // probe below remains the authoritative connection result.
    }
    return undefined;
  };

  options.onChange(snapshot());

  return {
    current: snapshot,

    async check(): Promise<RemoteConnectionState> {
      const operation = beginOperation();
      restoreActiveCredentials?.();
      restoreActiveCredentials = undefined;
      deployment = undefined;
      update({ state: "checking" });
      const restoreCredentials = await authorizeResolvedTarget(
        operation.signal,
        operation.generation,
      );
      if (!isCurrent(operation.generation)) {
        restoreCredentials?.();
        return connection;
      }
      restoreActiveCredentials = restoreCredentials;
      const probe = await probeRemoteInfo({
        client: options.client,
        phase: "connection-check",
      });
      if (!isCurrent(operation.generation)) return connection;
      return update(probe);
    },

    async authenticate(
      prepare: (signal: AbortSignal) => Promise<RemoteAuthPreparation>,
      signal?: AbortSignal,
    ): Promise<RemoteAuthCompletion> {
      const operation = beginOperation(signal);
      const previous = connection;
      const challenge = challengeFor(connection);
      update({ state: "authenticating", challenge });

      let preparation: RemoteAuthPreparation;
      try {
        preparation = await prepare(operation.signal);
      } catch (error) {
        preparation = {
          kind: "failed",
          message: toErrorMessage(error),
          completedMutations: [],
        };
      }

      if (!isCurrent(operation.generation)) {
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (preparation.kind === "cancelled") {
        update(previous);
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (preparation.kind === "failed") {
        update(previous.state === "ready" ? previous : { state: "auth-failed", challenge });
        return { kind: "failed", message: preparation.message };
      }
      if (operation.signal.aborted) {
        update(previous);
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }

      const restorePreviousCredentials = restoreActiveCredentials;
      let restoreCandidateCredentials: () => void;
      try {
        restoreCandidateCredentials = options.credentials.authorize({
          target: preparation.target,
          resolveToken: preparation.resolveToken,
        });
      } catch (error) {
        const message = appendRemoteAuthMutationSummary(
          toErrorMessage(error),
          preparation.completedMutations,
        );
        update({ state: "auth-failed", challenge });
        return { kind: "failed", message };
      }
      const verified = await probeRemoteInfo({
        client: options.client,
        phase: "authentication-verification",
      });
      if (!isCurrent(operation.generation)) {
        restoreCandidateCredentials();
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (operation.signal.aborted) {
        restoreCandidateCredentials();
        update(previous);
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (verified.state === "ready") {
        publishTarget(preparation.target);
        restoreActiveCredentials = () => {
          restoreCandidateCredentials();
          restorePreviousCredentials?.();
        };
        update(verified);
        return { kind: "authenticated" };
      }
      restoreCandidateCredentials();
      if (verified.state === "auth-required") {
        const message = appendRemoteAuthMutationSummary(
          `The selected Vercel project did not authorize ${remoteHost(options.target)}.`,
          preparation.completedMutations,
        );
        update({ state: "auth-failed", challenge: verified.challenge });
        return { kind: "failed", message };
      }

      const failure = {
        ...verified.failure,
        message: appendRemoteAuthMutationSummary(
          verified.failure.message,
          preparation.completedMutations,
        ),
      };
      update({ state: "unavailable", failure });
      return { kind: "unavailable", failure };
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
      restoreActiveCredentials?.();
      restoreActiveCredentials = undefined;
    },
  };
}
