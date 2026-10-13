import { buildEveToolMap } from "@github-tools/sdk/eve";
import { getToken, UserAuthorizationRequiredError } from "@vercel/connect";
import { defineDynamic } from "eve/tools";
import { CONNECT_USER_ISSUER, GITHUB_CONNECTOR } from "../../lib/connect.js";

/** Who the tools act for: a GitHub subject the user has authorized, or `null`. */
type GitHubSubject = { readonly type: "user"; readonly id: string; readonly issuer: string } | null;

export default defineDynamic({
  select: (_view, { session }) => session.auth.current,
  // Checks the user has connected GitHub. eve records the subject, never the token.
  record: async (auth): Promise<GitHubSubject> => {
    const userId = auth?.principalId;
    if (!userId || userId.startsWith("eve:")) return null;
    const subject = {
      type: "user" as const,
      id: userId,
      issuer: auth.issuer ?? auth.authenticator ?? CONNECT_USER_ISSUER,
    };
    try {
      await getToken(GITHUB_CONNECTOR, { subject, scopes: ["repo"] });
      return subject;
    } catch (error) {
      if (error instanceof UserAuthorizationRequiredError) return null;
      throw error;
    }
  },
  // Each call fetches a current token for the subject.
  render: (subject) =>
    subject === null
      ? {}
      : buildEveToolMap({
          preset: "maintainer",
          token: () => getToken(GITHUB_CONNECTOR, { subject, scopes: ["repo"] }),
        }),
});
