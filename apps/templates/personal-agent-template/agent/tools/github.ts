import { buildEveToolMap } from "@github-tools/sdk/eve";
import { getToken, UserAuthorizationRequiredError } from "@vercel/connect";
import { defineDynamic } from "eve/tools";
import { CONNECT_USER_ISSUER, GITHUB_CONNECTOR } from "../../lib/connect.js";

/** Who the tools act for: a GitHub subject the user has authorized, or `null`. */
type GitHubSubject = { readonly type: "user"; readonly id: string; readonly issuer: string } | null;

export default defineDynamic(async (ctx) => {
  const auth = ctx.session.auth.current;
  const userId = auth?.principalId;
  if (!auth || !userId || userId.startsWith("eve:")) return {};
  // Checks once per caller that the user has connected GitHub. eve keeps the subject, never the
  // token.
  const subject = await ctx.memo(auth, async (): Promise<GitHubSubject> => {
    const candidate = {
      type: "user" as const,
      id: userId,
      issuer: auth.issuer ?? auth.authenticator ?? CONNECT_USER_ISSUER,
    };
    try {
      await getToken(GITHUB_CONNECTOR, { subject: candidate, scopes: ["repo"] });
      return candidate;
    } catch (error) {
      if (error instanceof UserAuthorizationRequiredError) return null;
      throw error;
    }
  });
  // Each call fetches a current token for the subject.
  return subject === null
    ? {}
    : buildEveToolMap({
        preset: "maintainer",
        token: () => getToken(GITHUB_CONNECTOR, { subject, scopes: ["repo"] }),
      });
});
