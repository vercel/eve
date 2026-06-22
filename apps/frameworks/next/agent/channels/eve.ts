import { eveChannel } from "eve/channels/eve";
import { agentChannelAuth } from "../channel-auth";

export default eveChannel({
  auth: agentChannelAuth,
});
