import { eveChannel } from "eve/channels/eve";
import { localDev, type AuthFn, vercelOidc } from "eve/channels/auth";
import { auth } from "@/lib/auth";
import { sessionViewer } from "../../lib/session-viewer";
import { productionSessionStore } from "../../lib/production-session-store";
import { withSessionAccess } from "../../lib/session-access";

const betterAuthSession: AuthFn<Request> = async (request) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;

  const attributes: Record<string, string> = {
    email: session.user.email,
    name: session.user.name,
  };
  if (session.user.image) {
    attributes.picture = session.user.image;
  }

  return {
    attributes,
    authenticator: "better-auth:vercel",
    principalId: session.user.id,
    principalType: "user",
  };
};

const channel = eveChannel({
  auth: [betterAuthSession, vercelOidc(), localDev()],
});
export default withSessionAccess(channel, { viewer: sessionViewer, store: productionSessionStore });
