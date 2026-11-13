import type { Channel } from "eve/channels";
import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const channel: Channel = eveChannel({
  auth: [localDev()],
});

export default channel;
