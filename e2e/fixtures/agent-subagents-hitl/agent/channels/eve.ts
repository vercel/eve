import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel, type EveAuthFn } from "eve/channels/eve";

/**
 * Fixture-only: a request naming `x-eve-fixture-user` runs as that user, so a sign-in has a
 * person to ask. Every other request authenticates as the default eve channel does.
 */
const fixtureUser: EveAuthFn = (request) => {
  const principalId = request.headers.get("x-eve-fixture-user");
  if (principalId === null) return null;
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

export default eveChannel({ auth: [fixtureUser, vercelOidc(), localDev(), placeholderAuth()] });
