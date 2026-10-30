import browser from "@agent-browser/eve";

import { BROWSER_SESSION } from "../../lib/devices";

// The tools/ overrides beside this file add a screenshot to each browser action for the live
// view. A fixed session lets the live view stream the same browser the agent drives.
export default browser({ session: BROWSER_SESSION });
