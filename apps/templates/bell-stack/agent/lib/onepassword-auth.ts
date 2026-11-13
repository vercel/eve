import { defineInteractiveAuthorization, type ConnectionPrincipal } from "eve/connections";
import type { ToolContext } from "eve/tools";
import { getOnePassword, type Resume } from "../../server/onepassword/oauth";
import { failed, ownerOf } from "../../server/onepassword/config";

export function onePasswordPrincipal(ctx: ToolContext): ConnectionPrincipal {
  const auth = ctx.session.auth.current;
  const principal: ConnectionPrincipal = auth?.principalType === "user" && auth.authenticator === "linq-message" ? { type: "user", id: auth.principalId, issuer: auth.issuer } : { type: "app" };
  ownerOf(principal);
  return principal;
}
export async function safeOnePassword<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Error && ["ConnectionAuthorizationRequiredError", "ConnectionAuthorizationFailedError"].includes(error.name)) throw error;
    return failed("request_failed");
  }
}
export function createOnePasswordAuth(service = getOnePassword) {
  return defineInteractiveAuthorization<Resume>({
    displayName: "1Password",
    getToken: ({ principal }) => safeOnePassword(() => service().getToken(principal)),
    startAuthorization: ({ principal, callbackUrl }) => safeOnePassword(() => service().start(principal, callbackUrl)),
    completeAuthorization: ({ principal, callbackUrl, resume, callback }) => safeOnePassword(() => service().complete(principal, callbackUrl, resume, callback.params)),
  });
}
export const onePasswordAuth = createOnePasswordAuth();
