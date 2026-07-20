import { AgentInfoResponseError, ClientError, type Client } from "#client/index.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

import { probeAgentInfo } from "./agent-info-probe.js";
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

/**
 * Confirms the target is a live eve deployment via the always-public health
 * route. Used to corroborate a missing info route before declaring a connection
 * ready, so a host that simply 404s everything is not mistaken for a degraded
 * deployment whose `/eve/v1/info` is absent.
 */
async function probeDeploymentHealth(client: Client): Promise<boolean> {
  try {
    const health: unknown = await client.health();
    return isObject(health) && health.ok === true;
  } catch {
    return false;
  }
}

export async function probeRemoteInfo(input: {
  readonly client: Client;
  readonly phase: RemoteProbePhase;
}): Promise<RemoteProbeResult> {
  const probe = await probeAgentInfo({ client: input.client });
  if (probe.kind === "ready") return { state: "ready", info: probe.info };

  const { error } = probe;
  // Inspection is best-effort: an authorized response we cannot use must not
  // block the connection, since the conversation transport does not depend on
  // `/eve/v1/info`.
  if (
    error instanceof AgentInfoResponseError ||
    (error instanceof ClientError && error.status === 404)
  ) {
    // The info route can be missing or use an older payload shape. Only call
    // the target ready once the public health route confirms a live Eve server.
    if (await probeDeploymentHealth(input.client)) return { state: "ready" };
  }
  return classifyRemoteError(error, input.phase);
}
