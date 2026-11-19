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

export interface ConnectUserClient {
  readonly getTokenResponse: typeof getTokenResponse;
  readonly startAuthorization: typeof startAuthorization;
  readonly deleteTokenCacheEntry: typeof deleteTokenCacheEntry;
}

const CONNECT: ConnectUserClient = { getTokenResponse, startAuthorization, deleteTokenCacheEntry };

type Phase = "getToken" | "startAuthorization" | "completeAuthorization";

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
        if (!response.url && !response.deviceCode) {
          throw new ConnectionAuthorizationFailedError("connect", {
            message: `Vercel Connect started an authorization for ${connector} without a sign-in URL or device code.`,
            reason: "missing_challenge",
            retryable: false,
          });
        }
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
      try {
        client.deleteTokenCacheEntry(connector, params(principal));
      } catch {}
    },
  };
}

function translate(error: unknown, phase: Phase): Error {
  if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) {
    if (phase === "completeAuthorization") {
      return new ConnectionAuthorizationFailedError("connect", {
        message:
          "The sign-in didn't finish, so you do not have access yet. Ask again for a new sign-in link and complete all steps to gain access.",
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
