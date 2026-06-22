import { ClientError, type Client } from "#client/index.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

import type { RemoteConnectionState } from "./remote-connection-types.js";

export type RemoteProbeResult = Extract<
  RemoteConnectionState,
  { state: "ready" | "auth-required" | "unavailable" }
>;

export type RemoteProbePhase = "connection-check" | "authentication-verification";

function isEveOidcChallenge(error: unknown): boolean {
  if (!(error instanceof ClientError) || error.status !== 401) return false;

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

export function classifyRemoteError(error: unknown, phase: RemoteProbePhase): RemoteProbeResult {
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
    const failure = { message: formatVercelTrustedSourcesFailure(error.message) };
    return {
      state: "unavailable",
      failure: code === undefined ? failure : { ...failure, code },
    };
  }
  return {
    state: "unavailable",
    failure: { message: toErrorMessage(error) },
  };
}

export async function probeRemoteInfo(input: {
  readonly client: Client;
  readonly phase: RemoteProbePhase;
}): Promise<RemoteProbeResult> {
  try {
    return { state: "ready", info: await input.client.info() };
  } catch (error) {
    return classifyRemoteError(error, input.phase);
  }
}
