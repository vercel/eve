import { tab_close } from "@agent-browser/eve/tools";

import { captureBrowser, withScreen } from "../../../lib/screen";

export default withScreen(tab_close, captureBrowser);
