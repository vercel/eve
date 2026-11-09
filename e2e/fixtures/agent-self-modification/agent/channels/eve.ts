import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// The local self-modification editor is offered only to the developer running `eve dev`.
export default eveChannel({ auth: [localDev()] });
