import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  type ConnectionPrincipal,
} from "eve/connections";
import {
  consumeLinkAuthorization,
  getLinkToken,
  LinkConnectionRequiredError,
  startLinkAuthorization,
} from "@db/services/auth/link";
import { applicationOrigin } from "@shared/environment/origin";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

function accountUserId(principal: ConnectionPrincipal) {
  // Scheduled workers and delivery-only reports cannot acquire wallet access.
  if (
    principal.type !== "user" ||
    !principal.id.startsWith("better-auth:") ||
    principal.attributes?.scheduleId
  ) {
    throw new ConnectionAuthorizationFailedError("link", {
      reason: "principal_required",
      retryable: false,
    });
  }
  scopeFromPrincipal(principal);
  return principal.id.slice("better-auth:".length);
}

async function getToken(principal: ConnectionPrincipal) {
  try {
    return await getLinkToken(accountUserId(principal));
  } catch (error) {
    if (error instanceof LinkConnectionRequiredError)
      throw new ConnectionAuthorizationRequiredError("link");
    throw error;
  }
}

export const linkAuth = defineInteractiveAuthorization<{ attempt: string }>({
  displayName: "Link wallet",
  getToken: ({ principal }) => getToken(principal),
  async startAuthorization({ principal, callbackUrl }) {
    const { attempt, expiresAt } = await startLinkAuthorization(
      accountUserId(principal),
      callbackUrl
    );
    return {
      challenge: {
        url: `${applicationOrigin()}/api/link?attempt=${attempt}`,
        instructions: "Connect your Link wallet to continue.",
        expiresAt,
      },
      resume: { attempt },
    };
  },
  async completeAuthorization({ principal, callback, resume }) {
    if (
      !resume ||
      callback.params.attempt !== resume.attempt ||
      !(await consumeLinkAuthorization(
        accountUserId(principal),
        resume.attempt
      ))
    ) {
      throw new ConnectionAuthorizationFailedError("link", {
        reason: "invalid_state",
        retryable: false,
      });
    }
    if (callback.params.error) {
      throw new ConnectionAuthorizationFailedError("link", {
        reason: "access_denied",
        retryable: false,
      });
    }
    return getToken(principal);
  },
});
