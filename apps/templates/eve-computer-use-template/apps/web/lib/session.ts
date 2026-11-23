import { getPasswordSessionFromHeaders } from "./password-auth.ts";
import { getAuthMode } from "./setup.ts";

/** Who is using the app. Password access has one shared viewer. */
export interface Viewer {
  readonly id: string;
  readonly name: string;
}

const SHARED_VIEWER: Viewer = { id: "eve-computer-use-user", name: "eve user" };

/** The signed-in viewer for a request's headers, or null when no one is signed in. */
export function getViewer(headers: Headers): Viewer | null {
  switch (getAuthMode()) {
    case "local-dev":
      return SHARED_VIEWER;
    case "password":
      return getPasswordSessionFromHeaders(headers) ? SHARED_VIEWER : null;
    case "unconfigured":
      return null;
  }
}
