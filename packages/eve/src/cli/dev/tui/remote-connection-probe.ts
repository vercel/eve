import { ClientError, type Client } from "#client/index.js";
import { isVercelAuthChallenge } from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

import type { RemoteConnectionState } from "./remote-connection-types.js";

export type RemoteProbeResult = Extract<
  RemoteConnectionState,
  { state: "ready" | "auth-required" | "unavailable" }
>;

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

export function classifyRemoteError(error: unknown): RemoteProbeResult {
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
    return { state: "unavailable", failure: { message: error.message } };
  }
  return {
    state: "unavailable",
    failure: { message: toErrorMessage(error) },
  };
}

export async function probeRemoteInfo(input: {
  readonly client: Client;
}): Promise<RemoteProbeResult> {
  try {
    return { state: "ready", info: await input.client.info() };
  } catch (error) {
    return classifyRemoteError(error);
  }
}
