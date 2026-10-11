import { eveChannel } from "eve/channels/eve";

import { USER_HEADER } from "../../fixture";

/** Fixture-only authentication: evals name the speaker, so turns have a user to forward. */
export default eveChannel({
  auth: (request) => {
    const principalId = request.headers.get(USER_HEADER) ?? "e2e-eval";
    return {
      attributes: {},
      authenticator: "e2e-fixture",
      issuer: "e2e",
      principalId,
      principalType: "user",
      subject: principalId,
    };
  },
});
