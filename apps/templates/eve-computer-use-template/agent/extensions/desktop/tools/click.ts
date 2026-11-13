import { click } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(click, captureDesktop);
