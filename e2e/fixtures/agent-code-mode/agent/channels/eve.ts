import { eveChannel } from "eve/channels/eve";
export default eveChannel({
  auth: () => ({
    authenticator: "fixture",
    principalId: "fixture",
    principalType: "user",
    attributes: {},
  }),
});
