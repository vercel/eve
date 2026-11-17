import { eveChannel, type EveAuthFn } from "eve/channels/eve";

/**
 * Fixture-only authentication: each eval names its own person, so personal
 * skills from one run, or one eval, never reach another's.
 */
const authenticate: EveAuthFn = (request) => {
  const principalId = request.headers.get("x-eve-fixture-user") ?? "e2e-custom-skills";
  return {
    allowAgentInfo: true,
    attributes: {},
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
};

export default eveChannel({ auth: authenticate });
