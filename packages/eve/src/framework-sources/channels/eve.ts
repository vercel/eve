import { localDev, placeholderAuth, vercelOidc } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";

export default () =>
  eveChannel({
    auth: [vercelOidc(), localDev(), placeholderAuth()],
  });
