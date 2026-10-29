import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { getSession } from "../../lib/session";

const appSession: AuthFn<Request> = async (request) => {
  const session = await getSession(request.headers.get("cookie"));
  if (!session) return null;
  return {
    authenticator: "app-session",
    principalType: "user",
    principalId: session.userId,
    attributes: { orgId: session.orgId, role: session.role },
  };
};

export default eveChannel({
  auth: [appSession],
  uploadPolicy: { maxBytes: 3 * 1024 * 1024, allowedMediaTypes: ["application/pdf"] },
});
