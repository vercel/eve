import { eveChannel, type EveAuthFn } from "eve/channels/eve";

import { USER_HEADER } from "../../fixture";

/**
 * Fixture-only authentication: evals name the speaker, so turns have a user to forward.
 * Every caller is the eval driver, which reads agent info.
 */
const authenticate: EveAuthFn = (request) => {
  const principalId = request.headers.get(USER_HEADER) ?? "e2e-eval";
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
