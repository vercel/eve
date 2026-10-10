import { ConnectionAuthorizationRequiredError } from "eve/connections";
import type { ToolAuthProvider } from "eve/tools";

/**
 * Tokens kept after sign-in, by user. Module scope because a dynamic
 * connection builds a new provider each time it resolves.
 */
const rememberedTokens = new Map<string, string>();

/** Simulates the external auth service; the tool uses eve's real ctx auth methods. */
export function createFakeAuthProvider({
  expiredToken,
  rememberSignIns = false,
}: {
  expiredToken: boolean;
  /**
   * Keep each user's token after sign-in, as a real provider does. eve caches a
   * token only for the step that completed the sign-in, so later steps need it.
   */
  rememberSignIns?: boolean;
}): ToolAuthProvider {
  return {
    principalType: "user",
    async getToken({ principal }) {
      if (expiredToken) return { token: "expired-fixture-token" };
      const token =
        rememberSignIns && principal.type === "user"
          ? rememberedTokens.get(principal.id)
          : undefined;
      if (token !== undefined) return { token };
      throw new ConnectionAuthorizationRequiredError("workflow-step");
    },
    async startAuthorization({ principal, callbackUrl }) {
      if (principal.type !== "user") throw new Error("Expected a requester");
      const url = new URL(callbackUrl);
      url.searchParams.set("code", principal.id);
      return { challenge: { url: url.href }, resume: { user: principal.id } };
    },
    async completeAuthorization({ principal, callback, resume }) {
      if (
        principal.type !== "user" ||
        callback.params.code !== principal.id ||
        (resume as { user: string }).user !== principal.id
      ) {
        throw new Error("Authorization did not match the workflow requester");
      }
      const token = "authorized-fixture-token";
      if (rememberSignIns) rememberedTokens.set(principal.id, token);
      return { token };
    },
  };
}
