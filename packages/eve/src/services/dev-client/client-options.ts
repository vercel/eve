import type { ClientOptions } from "#client/index.js";

import type { DevelopmentCredentialGate } from "./credential-gate.js";

/**
 * Builds anonymous {@link ClientOptions} for a development target. Locality is
 * not an authorization decision, so remote URLs receive no ambient Vercel
 * credentials through this default path.
 */
export function resolveDevelopmentClientOptions(serverUrl: string): ClientOptions {
  return { host: serverUrl };
}

/** Builds non-redirecting client options backed by one verified credential gate. */
export function resolveRemoteDevelopmentClientOptions(input: {
  readonly credentials: DevelopmentCredentialGate;
  readonly serverUrl: string;
}): ClientOptions {
  const serverOrigin = new URL(input.serverUrl).origin;
  if (input.credentials.serverOrigin !== serverOrigin) {
    throw new Error(
      `Credential gate origin ${input.credentials.serverOrigin} does not match client origin ${serverOrigin}.`,
    );
  }
  return {
    auth: { vercelOidc: { token: () => input.credentials.resolveToken() } },
    headers: input.credentials.resolveBypassHeaders,
    host: input.serverUrl,
    redirect: "manual",
  };
}
