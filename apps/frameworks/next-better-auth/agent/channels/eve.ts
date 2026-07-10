import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { auth } from "@/lib/auth";

function betterAuthSession(): AuthFn<Request> {
  return async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });

    if (session === null) return null;

    const attributes: Record<string, string> = {
      email: session.user.email,
      name: session.user.name,
    };

    return {
      attributes,
      authenticator: "better-auth",
      issuer: process.env.BETTER_AUTH_URL,
      principalId: session.user.id,
      principalType: "user",
      subject: session.user.id,
    };
  };
}

export default eveChannel({
  auth: [betterAuthSession(), vercelOidc(), localDev()],
});
