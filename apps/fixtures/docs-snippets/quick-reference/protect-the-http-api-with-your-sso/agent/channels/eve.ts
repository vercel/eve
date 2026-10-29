import { localDev, oidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [oidc({ issuer: "https://sso.example.com", audiences: ["my-agent"] }), localDev()],
});
