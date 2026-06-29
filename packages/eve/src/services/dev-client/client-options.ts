import type { ClientOptions } from "#client/index.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";

import type { DevelopmentCredentialGate } from "./credential-gate.js";

type DevelopmentClientHeaders = Readonly<Record<string, string>>;

function hasAuthorizationHeader(
  headers: DevelopmentClientHeaders | undefined,
): headers is DevelopmentClientHeaders {
  return (
    headers !== undefined &&
    Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
  );
}

async function resolveRemoteHeaders(input: {
  readonly credentials: DevelopmentCredentialGate;
  readonly headers: DevelopmentClientHeaders | undefined;
  readonly includeTrustedOidcHeader: boolean;
}): Promise<DevelopmentClientHeaders> {
  if (!input.includeTrustedOidcHeader) {
    return {
      ...(await input.credentials.resolveBypassHeaders()),
      ...input.headers,
    };
  }

  const [bypassHeaders, token] = await Promise.all([
    input.credentials.resolveBypassHeaders(),
    input.credentials.resolveToken(),
  ]);
  const headers: Record<string, string> = {
    ...bypassHeaders,
    ...input.headers,
  };
  const trimmedToken = token.trim();
  if (trimmedToken.length > 0) {
    headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = trimmedToken;
  }
  return headers;
}

/**
 * Builds anonymous {@link ClientOptions} for a development target. Locality is
 * not an authorization decision, so remote URLs receive no ambient Vercel
 * credentials through this default path.
 */
export function resolveDevelopmentClientOptions(serverUrl: string): ClientOptions {
  return { host: serverUrl };
}

/** Builds a non-redirecting local client, using ambient bearer auth only when it owns Authorization. */
export function resolveLocalDevelopmentClientOptions(input: {
  readonly headers?: DevelopmentClientHeaders;
  readonly serverUrl: string;
  readonly token: () => Promise<string>;
}): ClientOptions {
  const options = {
    host: input.serverUrl,
    redirect: "manual",
  } satisfies ClientOptions;

  if (hasAuthorizationHeader(input.headers)) {
    return { ...options, headers: input.headers };
  }

  const authorizedOptions = {
    ...options,
    auth: { bearer: input.token },
  } satisfies ClientOptions;

  if (input.headers !== undefined) {
    return { ...authorizedOptions, headers: input.headers };
  }
  return authorizedOptions;
}

/** Builds non-redirecting client options backed by one verified credential gate. */
export function resolveRemoteDevelopmentClientOptions(input: {
  readonly credentials: DevelopmentCredentialGate;
  readonly headers?: DevelopmentClientHeaders;
  readonly serverUrl: string;
}): ClientOptions {
  const serverOrigin = new URL(input.serverUrl).origin;
  if (input.credentials.serverOrigin !== serverOrigin) {
    throw new Error(
      `Credential gate origin ${input.credentials.serverOrigin} does not match client origin ${serverOrigin}.`,
    );
  }
  if (hasAuthorizationHeader(input.headers)) {
    return {
      headers: () =>
        resolveRemoteHeaders({
          credentials: input.credentials,
          headers: input.headers,
          includeTrustedOidcHeader: true,
        }),
      host: input.serverUrl,
      redirect: "manual",
    };
  }

  return {
    auth: { vercelOidc: { token: () => input.credentials.resolveToken() } },
    headers:
      input.headers === undefined
        ? input.credentials.resolveBypassHeaders
        : () =>
            resolveRemoteHeaders({
              credentials: input.credentials,
              headers: input.headers,
              includeTrustedOidcHeader: false,
            }),
    host: input.serverUrl,
    redirect: "manual",
  };
}
