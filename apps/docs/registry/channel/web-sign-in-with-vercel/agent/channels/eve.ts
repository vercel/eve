import { eveChannel } from "eve/channels/eve";
import { localDev, type AuthFn, vercelOidc } from "eve/channels/auth";
import { sessionViewer } from "../../lib/session-viewer";
import { productionSessionStore } from "../../lib/production-session-store";
import { withSessionAccess } from "../../lib/session-access";

// sessionViewer verifies the Better Auth cookie and shares its identity with ownership checks.
const betterAuthSession: AuthFn<Request> = async (request) =>
  (await sessionViewer(request))?.principal ?? null;

const channel = eveChannel({ auth: [betterAuthSession, vercelOidc(), localDev()] });
export default withSessionAccess(channel, { viewer: sessionViewer, store: productionSessionStore });
