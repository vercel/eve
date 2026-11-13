import { mouse_wheel } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(mouse_wheel, captureDesktop);
