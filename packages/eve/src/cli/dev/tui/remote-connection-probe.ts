import { AgentInfoResponseError, ClientError, type Client } from "#client/index.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import {
  formatAgentInfoForbiddenMessage,
  isAgentInfoForbidden,
} from "#shared/agent-info-access.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

import { probeAgentInfo } from "#services/dev-client/agent-info-probe.js";
import type { RemoteConnectionState } from "./remote-connection-types.js";

type RemoteProbeResult = Extract<
  RemoteConnectionState,
  { state: "ready" | "auth-required" | "unavailable" }
>;

type RemoteProbePhase = "connection-check" | "authentication-verification";

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
  if (
    error instanceof AgentInfoResponseError ||
    (error instanceof ClientError && error.status === 404)
  ) {
    if (await probeDeploymentHealth(input.client)) return { state: "ready" };
  }
  if (isAgentInfoForbidden(error) && (await probeDeploymentHealth(input.client))) {
    return { state: "ready", warning: formatAgentInfoForbiddenMessage("The remote agent") };
  }
  return classifyRemoteError(error, input.phase);
}
