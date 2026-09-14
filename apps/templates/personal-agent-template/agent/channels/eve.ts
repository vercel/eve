import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { vercelOidc } from "eve/channels/auth";
import { auth } from "../../auth";

function appSession(): AuthFn<Request> {
  return async (request) => {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return null;
    }

    return {
      attributes: {
        email: session.user.email,
        name: session.user.name,
      },
      authenticator: "app",
      issuer: "app",
      principalId: session.user.id,
      principalType: "user",
    };
  };
}

export default eveChannel({
  auth: [appSession(), vercelOidc()],
});
