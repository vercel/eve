import { defineInteractiveAuthorization, isConnectionAuthorizationRequiredError, type ConnectionPrincipal } from "eve/connections";
import type { ToolContext } from "eve/tools";
import { getLinkOAuth, linkOwner, safeLinkCall, type LinkResume } from "../../server/link/oauth";
import { assertSandboxRequest, isLinkSandbox, sandboxToken } from "../../server/link/sandbox";

export function createLinkAuth(service = getLinkOAuth) {
  const hosted = () => {
    if (isLinkSandbox()) throw new Error("The sandbox uses an operator-supplied token and test spend tools; hosted wallet OAuth and wallet-history tools are unavailable.");
    return service();
  };
  return defineInteractiveAuthorization<LinkResume>({
    displayName: "Link",
    getToken: ({ principal }) => safeLinkCall(() => {
      linkOwner(principal);
      return hosted().getToken(principal);
    }),
    evict: ({ principal }) => safeLinkCall(() => {
      linkOwner(principal);
      return hosted().evict(principal);
    }),
    startAuthorization: ({ principal, callbackUrl }) => safeLinkCall(() => {
      linkOwner(principal);
      return hosted().start(principal, callbackUrl);
    }),
    completeAuthorization: ({ principal, callbackUrl, resume, callback }) => safeLinkCall(() => {
      linkOwner(principal);
      return hosted().complete(principal, callbackUrl, resume, callback.params);
    }),
  });
}

export const linkAuth = createLinkAuth();

export function linkPrincipal(ctx: ToolContext): ConnectionPrincipal {
  const auth = ctx.session.auth.current;
  const principal: ConnectionPrincipal = auth?.principalType === "user" && auth.authenticator === "linq-message"
    ? { type: "user", id: auth.principalId, issuer: auth.issuer }
    : { type: "app" };
  linkOwner(principal);
  return principal;
}

/** Preserve Eve's authorization pause/resume, then recheck the database before each
 * native SDK request. A bearer cached earlier in a step must not bypass a
 * concurrent disconnect from another conversation.
 */
export function freshLinkContext(ctx: ToolContext, requestId?: string, sandboxOperation?: "create" | "list"): ToolContext {
  if (isLinkSandbox()) {
    const principal = linkPrincipal(ctx);
    sandboxToken(principal);
    if (requestId) assertSandboxRequest(requestId);
    else if (!sandboxOperation) throw new Error("The sandbox exposes test spend requests only, not saved wallet details or payment history.");
    return { ...ctx, getToken: async () => sandboxToken(principal), requireAuth: () => {
      throw new Error("The sandbox token expired or was rejected. Replace it in the process environment; do not retry an uncertain purchase.");
    } };
  }
  return {
    ...ctx,
    async getToken(provider) {
      await ctx.getToken(provider);
      try {
        return await provider.getToken({ principal: linkPrincipal(ctx), connection: { url: "" } });
      } catch (error) {
        if (isConnectionAuthorizationRequiredError(error)) ctx.requireAuth(provider);
        throw error;
      }
    },
  };
}
