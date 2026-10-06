import { eveChannel } from "eve/channels/eve";

import { USER_HEADER } from "../../fixture";

/** Fixture-only authentication: evals name the person they speak as. */
export default eveChannel({
  auth: (request) => ({
    attributes: {},
    authenticator: "e2e-fixture",
    principalId: request.headers.get(USER_HEADER) ?? "e2e-eval",
    principalType: "user",
  }),
});
