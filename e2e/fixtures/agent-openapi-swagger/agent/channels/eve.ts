import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const SERVICE_AUTHORIZATION = "Bearer e2e-current-auth-service";
const USER_AUTHORIZATION = "Bearer e2e-current-auth-user";

function fixtureUser(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateService: AuthFn<Request> = (request) => {
  if (request.headers.get("authorization") !== SERVICE_AUTHORIZATION) return null;
  return {
    attributes: {},
    authenticator: "e2e-bearer",
    principalId: "e2e-service",
    principalType: "service",
  };
};

const authenticateUser: AuthFn<Request> = (request) => {
  if (request.headers.get("authorization") !== USER_AUTHORIZATION) return null;
  return fixtureUser("e2e-human");
};

const authenticateDefaultUser: AuthFn<Request> = () => fixtureUser("e2e-default-user");

export default eveChannel({
  auth: [authenticateService, authenticateUser, authenticateDefaultUser],
});
