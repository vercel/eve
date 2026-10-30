import {
  ConnectorInstallationRequiredError,
  deleteTokenCacheEntry,
  getTokenResponse,
  NoValidTokenError,
  startAuthorization,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  type ConnectionPrincipal,
  type InteractiveAuthorizationDefinition,
} from "eve/connections";

/** The Connect calls the sign-in uses; injectable for tests. */
export interface ConnectUserClient {
  readonly getTokenResponse: typeof getTokenResponse;
  readonly startAuthorization: typeof startAuthorization;
  readonly deleteTokenCacheEntry: typeof deleteTokenCacheEntry;
}

const CONNECT: ConnectUserClient = { getTokenResponse, startAuthorization, deleteTokenCacheEntry };

type Phase = "getToken" | "startAuthorization" | "completeAuthorization";

/**
 * Connect-backed sign-in for user-scoped `gh` tokens. It mirrors
 * `connect({ connector, principalType: "user" })` from `@vercel/connect/eve`,
 * which eve cannot bundle because it imports `eve` itself. Requests carry no
 * authorization details, so one grant serves every repository.
 */
export function connectUserAuthorization(
  connector: string,
  client: ConnectUserClient = CONNECT,
): InteractiveAuthorizationDefinition {
  const params = (principal: ConnectionPrincipal) => {
    if (principal.type !== "user") {
      throw new ConnectionAuthorizationFailedError("connect", {
        message: "User-scoped GitHub access requires a signed-in caller.",
        reason: "principal_required",
        retryable: false,
      });
    }
    return { subject: { type: "user" as const, id: principal.id, issuer: principal.issuer } };
  };
  const token = async (principal: ConnectionPrincipal, phase: Phase) => {
    try {
      const response = await client.getTokenResponse(connector, params(principal));
      return { token: response.token, expiresAt: response.expiresAt };
    } catch (error) {
      throw translate(error, phase);
    }
  };
  return {
    principalType: "user",
    vercelConnect: { connector },
    getToken: ({ principal }) => token(principal, "getToken"),
    async startAuthorization({ principal, callbackUrl }) {
      try {
        const response = await client.startAuthorization(connector, params(principal), {
          callbackUrl,
          deviceCode: true,
        });
        // Name the destination service, as Connect's eve helper does.
        const displayName = response.connector?.serviceName ?? response.connector?.name;
        return {
          challenge: {
            url: response.url,
            ...(response.deviceCode ? { userCode: response.deviceCode } : null),
            ...(response.expiresAt
              ? { expiresAt: new Date(response.expiresAt).toISOString() }
              : null),
            ...(displayName ? { displayName } : null),
          },
        };
      } catch (error) {
        throw translate(error, "startAuthorization");
      }
    },
    completeAuthorization: ({ principal }) => token(principal, "completeAuthorization"),
    evict({ principal }) {
      // Best effort: drop Connect's in-process token so re-authorization refreshes it.
      try {
        client.deleteTokenCacheEntry(connector, params(principal));
      } catch {}
    },
  };
}

/** Maps Connect errors to eve's authorization errors, as `@vercel/connect/eve` does for user connectors. */
function translate(error: unknown, phase: Phase): Error {
  if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) {
    if (phase === "completeAuthorization") {
      return new ConnectionAuthorizationFailedError("connect", {
        message:
          "Authorization did not complete. Vercel Connect still reports the user as unauthorized.",
      });
    }
    return new ConnectionAuthorizationRequiredError("connect", { message: error.message });
  }
  if (error instanceof ConnectorInstallationRequiredError) {
    return new ConnectionAuthorizationFailedError("connect", {
      message: error.message,
      reason: "connector_installation_required",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}
