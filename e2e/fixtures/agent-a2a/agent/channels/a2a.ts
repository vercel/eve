import { a2aChannel } from "eve/channels/a2a";
import { withAuthChallenges } from "eve/channels/auth";

export default a2aChannel({
  auth: withAuthChallenges(
    (request) => {
      const principalId = request.headers.get("x-e2e-principal");
      if (!principalId) return null;
      return { authenticator: "e2e", principalType: "user", principalId, attributes: {} };
    },
    [{ scheme: "Bearer" }],
  ),
  card: {
    securitySchemes: {
      principal: { apiKeySecurityScheme: { name: "x-e2e-principal", location: "header" } },
    },
    securityRequirements: [{ schemes: { principal: { list: [] } } }],
  },
});
