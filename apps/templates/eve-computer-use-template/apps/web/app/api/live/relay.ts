import { Sandbox } from "@vercel/sandbox";
import { Client } from "eve/client";

import {
  DESKTOP_STREAM_PORT,
  RELAY_PORT,
  RELAY_TOKEN_FILE,
} from "../../../../../agent/lib/live-config";

export interface Relay {
  /** The browser relay's WebSocket origin, on the sandbox's public port. Never sent to the browser. */
  readonly origin: string;
  readonly token: string;
}

/** A single-use way into the desktop's stream, for the caller's browser to connect directly. */
export interface DesktopTicket {
  /** screen-relay's `/stream` on its public sandbox port. */
  readonly url: string;
  /** Offer as the `ticket.<ticket>` subprotocol beside `nsl1`; it opens one connection within 60s. */
  readonly ticket: string;
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
 * The sandbox of an eve session, if the caller may read that session. eve's channel auth decides
 * the first part, through the session's own stream; eve itself tags each session's sandbox with
 * the session's ID when it creates it, which decides the second. Nothing in the session's
 * history, which code in the sandbox can shape, is trusted to name the sandbox.
 */
export async function findSandbox(request: Request, sessionId: string): Promise<Sandbox | null> {
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
  return sandbox.tags?.sessionId === sessionId ? sandbox : null;
}

/** The browser's relay in `sandbox`, with the token it wrote there. */
export async function browserRelay(sandbox: Sandbox): Promise<Relay | null> {
  const file = await sandbox.readFileToBuffer({ path: RELAY_TOKEN_FILE });
  if (file === null) return null;
  const { token } = JSON.parse(file.toString("utf8")) as { token: string };
  return { origin: sandbox.domain(RELAY_PORT).replace(/^http/, "ws"), token };
}

/**
 * A ticket into the desktop's stream in `sandbox`. screen-relay's own token stays here: it asks
 * screen-relay for a ticket with it, as screen-relay's remote access guide describes for custom
 * viewers, and only the ticket goes to the browser.
 */
export async function desktopTicket(sandbox: Sandbox): Promise<DesktopTicket | null> {
  const status = await sandbox.runCommand({
    cmd: "screen-relay",
    args: ["status", "--json", "--show-token"],
  });
  if (status.exitCode !== 0) return null;
  const token = (JSON.parse(await status.stdout()) as { session?: { token?: unknown } }).session
    ?.token;
  if (typeof token !== "string") return null;
  const origin = sandbox.domain(DESKTOP_STREAM_PORT);
  const response = await fetch(`${origin}/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const { ticket } = (await response.json()) as { ticket?: unknown };
  if (typeof ticket !== "string") return null;
  return { url: `${origin.replace(/^http/, "ws")}/stream`, ticket };
}
