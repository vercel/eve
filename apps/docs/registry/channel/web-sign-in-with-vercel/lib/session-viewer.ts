import { auth } from "./auth";
import { sessionOwner, type SessionOwner } from "./session-store";

export async function sessionViewer(request: Request): Promise<SessionOwner | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return sessionOwner(session?.user);
}
