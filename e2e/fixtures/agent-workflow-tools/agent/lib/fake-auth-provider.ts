import { ConnectionAuthorizationRequiredError } from "eve/connections";
import type { ToolAuthProvider } from "eve/tools";

/** Simulates the external auth service; the tool uses eve's real ctx auth methods. */
export function createFakeAuthProvider({
  expiredToken,
}: {
  expiredToken: boolean;
}): ToolAuthProvider {
  return {
    principalType: "user",
    async getToken() {
      if (expiredToken) return { token: "expired-fixture-token" };
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
      return { token: "authorized-fixture-token" };
    },
  };
}
