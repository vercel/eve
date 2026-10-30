import { Sandbox } from "@vercel/sandbox";
import { Client } from "eve/client";
import type { SessionStreamEvent } from "eve/client";

import {
  RELAY_PORT,
  RELAY_TOKEN_FILE,
  type LiveDevice,
} from "../../../../../agent/lib/live-config";

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
 * The relay for a device's live stream in an eve session, if the caller may read that session.
 * The session is the authority: it must authorize the caller, and its own tool results name the
 * sandbox, so a viewer can only reach the sandbox of a session they can already read.
 */
export async function findRelay(
  request: Request,
  sessionId: string,
  device: LiveDevice,
): Promise<Relay | null> {
  const eveUrl = process.env.EVE_URL;
  if (eveUrl === undefined)
    throw new Error("EVE_URL is not set; it comes from the web service's binding in vercel.ts.");
  const client = new Client({ baseUrl: eveUrl, headers: callerHeaders(request) });
  const events: SessionStreamEvent[] = [];
  try {
    // One read to the session's current tail. Without retries, a session the caller can't read
    // fails at once instead of being retried as if it might appear.
    const stream = client.sessions.attach(sessionId).stream({
      startIndex: 0,
      follow: false,
      reconnect: false,
      signal: AbortSignal.timeout(15_000),
    });
    for await (const event of stream) events.push(event);
  } catch {
    // Unauthorized, unknown, or unreachable: all read as "no stream" to the caller.
    return null;
  }

  const name = latestSandbox(events, device);
  if (name === undefined) return null;
  const sandbox = await Sandbox.get({ name });
  const file = await sandbox.readFileToBuffer({ path: RELAY_TOKEN_FILE });
  if (file === null) return null;
  const { token } = JSON.parse(file.toString("utf8")) as { token: string };
  return { origin: sandbox.domain(RELAY_PORT).replace(/^http/, "ws"), token };
}

/** The sandbox the session's latest live stream for `device` runs in, from its tool results. */
function latestSandbox(
  events: readonly SessionStreamEvent[],
  device: LiveDevice,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "call.settled") continue;
    const output = (event.data as { output?: unknown }).output;
    const screen =
      typeof output === "object" && output !== null
        ? (output as { screen?: unknown }).screen
        : undefined;
    if (typeof screen !== "object" || screen === null) continue;
    const { device: screenDevice, sandbox } = screen as { device?: unknown; sandbox?: unknown };
    if (screenDevice === device && typeof sandbox === "string") return sandbox;
  }
  return undefined;
}
