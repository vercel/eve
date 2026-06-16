import type { ClientOptions } from "#client/index.js";

import {
  isLocalDevelopmentServerUrl,
  resolveDevelopmentClientHeaders,
  resolveDevelopmentOidcToken,
} from "./request-headers.js";

/**
 * Builds the {@link ClientOptions} every development client connects with:
 * local hosts skip the Vercel OIDC bearer (the framework's `localDev()`
 * channel auth accepts unauthenticated calls); remote hosts attach it
 * alongside any protection-bypass headers resolved per request.
 */
export function resolveDevelopmentClientOptions(serverUrl: string): ClientOptions {
  const base = {
    headers: () => resolveDevelopmentClientHeaders({ serverUrl }),
    host: serverUrl,
  };

  if (isLocalDevelopmentServerUrl(serverUrl)) {
    return base;
  }

  return { ...base, auth: { bearer: resolveDevelopmentOidcToken } };
}
