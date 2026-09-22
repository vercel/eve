import { createHash } from "node:crypto";
import type { AuthFn } from "eve/channels/auth";
import type { SessionOwner } from "./session-store.ts";

export interface SessionViewer extends SessionOwner {
  readonly principal: NonNullable<Awaited<ReturnType<AuthFn>>>;
}

// Call only with the result of the server-side authentication adapter.
export function viewerFromVerifiedSession(
  session: {
    user: { vercelSubject?: string | null; name: string; email: string; image?: string | null };
  } | null,
): SessionViewer | null {
  // Use the provider subject so ownership survives new sign-ins; older cookies need a new sign-in.
  const subject = session?.user.vercelSubject;
  if (!subject || !session) return null;
  const key = createHash("sha256")
    .update(JSON.stringify(["better-auth:vercel", subject]))
    .digest("hex");
  return {
    key,
    name: session.user.name || session.user.email,
    principal: {
      principalId: subject,
      principalType: "user",
      authenticator: "better-auth:vercel",
      attributes: {
        email: session.user.email,
        name: session.user.name,
        ...(session.user.image ? { picture: session.user.image } : {}),
        webSessionOwner: key,
      },
    },
  };
}
