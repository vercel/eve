import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { accessCookieAuth } from "../lib/access";

export default eveChannel({
  auth: [vercelOidc(), localDev(), accessCookieAuth(), placeholderAuth()],
});
