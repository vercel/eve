import { type AuthFn, localDev, oidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const sso = oidc({ issuer: "https://sso.example.com", audiences: ["my-agent"] });

// Only tokens that name a person become users. Machine tokens from the same
// issuer have no email claim and stay "service" principals.
const employee: AuthFn<Request> = async (request) => {
  const caller = await sso(request);
  if (!caller) return null;
  return typeof caller.attributes.email === "string"
    ? { ...caller, principalType: "user" }
    : caller;
};

export default eveChannel({ auth: [employee, localDev()] });
