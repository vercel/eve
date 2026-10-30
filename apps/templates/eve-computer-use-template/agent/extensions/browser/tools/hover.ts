import { hover } from "@agent-browser/eve/tools";

import { captureBrowser, withScreen } from "../../../lib/screen";

export default withScreen(hover, captureBrowser);
