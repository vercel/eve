import { Sandbox } from "@vercel/sandbox";
import { Client } from "eve/client";

import { RELAY_PORT, RELAY_TOKEN_FILE } from "../../../../../agent/lib/live-config";

export interface Relay {
  /** The relay's WebSocket origin, on the sandbox's public port. Never sent to the browser. */
  readonly origin: string;
  readonly token: string;
}

/** Only the caller's own credentials, so eve's channel auth decides whether they may read the session. */
function callerHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

/**
 * The relay for an eve session's live view, if the caller may read that session. eve's channel
 * auth decides the first part, through the session's own stream; eve itself tags each session's
 * sandbox with the session's ID when it creates it, which decides the second. Nothing in the
 * session's history, which code in the sandbox can shape, is trusted to name the sandbox.
 */
export async function findRelay(request: Request, sessionId: string): Promise<Relay | null> {
  const eveUrl = process.env.EVE_URL;
  if (eveUrl === undefined)
    throw new Error("EVE_URL is not set; it comes from the web service's binding in vercel.ts.");
  const session = new Client({ baseUrl: eveUrl, headers: callerHeaders(request) }).sessions.attach(
    sessionId,
  );
  try {
    // One event from the tail is enough to know the caller may read the session. Without
    // retries, a session the caller can't read fails at once.
    const stream = session.stream({
      startIndex: -1,
      follow: false,
      reconnect: false,
      signal: AbortSignal.timeout(15_000),
    });
    for await (const _event of stream) break;
  } catch {
    // Unauthorized, unknown, or unreachable: all read as "no stream" to the caller.
    return null;
  }
  const { sandboxes } = await Sandbox.list({ tags: { sessionId } });
  const name = sandboxes.find((sandbox) => sandbox.status === "running")?.name;
  if (name === undefined) return null;
  const sandbox = await Sandbox.get({ name });
  if (sandbox.tags?.sessionId !== sessionId) return null;
  const file = await sandbox.readFileToBuffer({ path: RELAY_TOKEN_FILE });
  if (file === null) return null;
  const { token } = JSON.parse(file.toString("utf8")) as { token: string };
  return { origin: sandbox.domain(RELAY_PORT).replace(/^http/, "ws"), token };
}
