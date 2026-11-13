import { expand } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(expand, captureDesktop);
