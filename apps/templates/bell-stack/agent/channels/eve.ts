import { eveChannel } from "eve/channels/eve";
import { vercelOidc } from "eve/channels/auth";

import { browserChannelEvents } from "../lib/browser-runtime";
import { localOperatorAuth, operatorAuth } from "../../server/operator-auth";

export default eveChannel({
  auth: [operatorAuth, vercelOidc(), localOperatorAuth],
  events: browserChannelEvents,
});
