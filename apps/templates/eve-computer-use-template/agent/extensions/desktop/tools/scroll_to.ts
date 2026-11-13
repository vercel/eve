import { scroll_to } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(scroll_to, captureDesktop);
