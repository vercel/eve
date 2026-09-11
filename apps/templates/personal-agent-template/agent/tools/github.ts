import { buildEveToolMap } from "@github-tools/sdk/eve";
import { getToken, UserAuthorizationRequiredError } from "@vercel/connect";
import { defineDynamic } from "eve/tools";
import { CONNECT_USER_ISSUER, GITHUB_CONNECTOR } from "../../shared/connect.js";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current;
      const userId = auth?.principalId;
      if (!userId || userId.startsWith("eve:")) {
        return {};
      }

      try {
        const token = await getToken(GITHUB_CONNECTOR, {
          subject: {
            type: "user",
            id: userId,
            issuer: auth.issuer ?? auth.authenticator ?? CONNECT_USER_ISSUER,
          },
          scopes: ["repo"],
        });
        return buildEveToolMap({ preset: "maintainer", token });
      } catch (error) {
        if (error instanceof UserAuthorizationRequiredError) {
          return {};
        }
        throw error;
      }
    },
  },
});
