import browser from "@agent-browser/eve";

import { BROWSER_SESSION } from "../lib/browser.js";

// The screen share and the saved sign-ins use the same browser session.
export default browser({ session: BROWSER_SESSION });
