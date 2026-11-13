import { mouse_click } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(mouse_click, captureDesktop);
