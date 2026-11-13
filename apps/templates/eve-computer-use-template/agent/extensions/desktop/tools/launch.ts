import { launch } from "@eve/agent-desktop/tools";

import { captureDesktop, withScreen } from "../../../lib/screen";

export default withScreen(launch, captureDesktop);
