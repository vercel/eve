import { headers } from "next/headers";
import { auth } from "./auth";
import { getPasswordSessionFromHeaders } from "./password-auth";
import type { SetupStatus } from "./setup";

export type Viewer = {
  readonly id: string;
  readonly name: string;
};

const SHARED_VIEWER: Viewer = { id: "eve-voice-user", name: "eve user" };

export async function getServerViewer(status: SetupStatus): Promise<Viewer | null> {
  const requestHeaders = await headers();

  switch (status.authMode) {
    case "local-dev":
      return SHARED_VIEWER;
    case "password":
      return getPasswordSessionFromHeaders(requestHeaders) ? SHARED_VIEWER : null;
    case "vercel": {
      const session = await auth.api.getSession({ headers: requestHeaders }).catch(() => null);
      return session?.user ? { id: session.user.id, name: session.user.name } : null;
    }
    case "unconfigured":
      return null;
  }
}
