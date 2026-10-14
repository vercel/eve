import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

export default eveChannel({ auth: localDev() });
