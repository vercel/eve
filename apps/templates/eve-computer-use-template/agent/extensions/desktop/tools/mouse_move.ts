import { mouse_move } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(mouse_move, captureDesktop);
