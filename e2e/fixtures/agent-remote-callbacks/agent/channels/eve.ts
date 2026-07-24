import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Interactive connection authorization is user-principal-only, so the
 * self-referential remote call must authenticate as a user. This entry
 * mints one from the fixture bearer that `probe-remote` sends (the same
 * constant lives there); everything else falls through to the default
 * walk, which is what the eval client uses.
 */
const E2E_USER_BEARER = "agent-remote-callbacks-e2e-user";

function e2eUser(): AuthFn<Request> {
  return (request) => {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${E2E_USER_BEARER}`) return null;
    return {
      attributes: {},
      authenticator: "e2e-fixture",
      principalId: "probe-caller",
      principalType: "user",
    };
  };
}

export default eveChannel({ auth: [e2eUser(), vercelOidc(), localDev()] });
