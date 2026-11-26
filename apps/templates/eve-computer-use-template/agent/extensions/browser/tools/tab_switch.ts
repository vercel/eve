import { tab_switch } from "@agent-browser/eve/tools";

import { captureBrowser, withScreen } from "../../../lib/screen";

export default withScreen(tab_switch, captureBrowser);
