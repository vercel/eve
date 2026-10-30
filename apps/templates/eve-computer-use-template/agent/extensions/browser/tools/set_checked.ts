import { set_checked } from "@agent-browser/eve/tools";

import { captureBrowser, withScreen } from "../../../lib/screen";

export default withScreen(set_checked, captureBrowser);
