import { eveChannel } from "eve/channels/eve";
import { demoAuth } from "../lib/demo-auth";

export default eveChannel({ auth: demoAuth });
