import { uncheck } from "@agent-browser/eve/tools";

import { captureBrowser, withScreen } from "../../../lib/screen";

export default withScreen(uncheck, captureBrowser);
