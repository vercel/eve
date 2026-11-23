import { extractBearerToken, verifyJwtHmac, withAuthChallenges } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { TOKEN } from "../token-config.js";

/** Accepts only an unexpired fixture session token, with no clock skew allowance. */
export default eveChannel({
  auth: withAuthChallenges(
    async (request) => {
      const result = await verifyJwtHmac(extractBearerToken(request.headers.get("authorization")), {
        algorithm: "HS256",
        audiences: [TOKEN.audience],
        clockSkewSeconds: 0,
        issuer: TOKEN.issuer,
        secret: TOKEN.secret,
      });
      if (!result.ok) return null;
      return {
        ...result.sessionAuth,
        principalType: "user" as const,
        allowAgentInfo: true,
        allowToolStubs: true,
      };
    },
    [{ scheme: "Bearer" }],
  ),
});
