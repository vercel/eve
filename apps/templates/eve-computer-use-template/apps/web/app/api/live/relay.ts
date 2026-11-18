import { Sandbox } from "@vercel/sandbox";
import { Client } from "eve/client";
import type { SessionStreamEvent } from "eve/client";

import {
  DEVICE_TOOL_PREFIX,
  RELAY_PORT,
  RELAY_TOKEN_FILE,
  type LiveDevice,
} from "../../../../../agent/lib/live-config";

/**
 * How far back from the session's tail each read starts, in stream lines; 0 reads it all. Every
 * device action records the sandbox, so the first window almost always finds it, and a long
 * session isn't replayed, screenshots and all, each time a viewer connects.
 */
const SEARCH_WINDOWS = [-256, -4096, 0];

export interface Relay {
  /** The relay's WebSocket origin, on the sandbox's public port. Never sent to the browser. */
  readonly origin: string;
  readonly token: string;
}

/**
 * Only the caller's own credentials, so eve's channel auth decides whether they may read the
 * session. The route has already refused pages on other sites, whose `Origin` `localDev()` can't
 * see through this server.
 */
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
 * The session is the authority: it must authorize the caller, and its device tools' results say
 * which sandbox runs the stream. Code in a sandbox can shape those results, so the sandbox must
 * also carry the `sessionId` tag eve gives each session's sandbox when it creates it: a viewer
 * only ever reaches the sandbox of a session they can already read.
 */
export async function findRelay(
  request: Request,
  sessionId: string,
  device: LiveDevice,
): Promise<Relay | null> {
  const eveUrl = process.env.EVE_URL;
  if (eveUrl === undefined)
    throw new Error("EVE_URL is not set; it comes from the web service's binding in vercel.ts.");
  const session = new Client({ baseUrl: eveUrl, headers: callerHeaders(request) }).sessions.attach(
    sessionId,
  );
  const signal = AbortSignal.timeout(15_000);
  let name: string | undefined;
  try {
    for (const startIndex of SEARCH_WINDOWS) {
      // Each read stops at the session's current tail. Without retries, a session the caller
      // can't read fails at once instead of being retried as if it might appear.
      const events: SessionStreamEvent[] = [];
      const stream = session.stream({ startIndex, follow: false, reconnect: false, signal });
      for await (const event of stream) events.push(event);
      name = latestSandbox(events, device);
      // A window that reaches back to the session's start has read all of it.
      if (name !== undefined || events[0]?.type === "session.started") break;
    }
  } catch {
    // Unauthorized, unknown, or unreachable: all read as "no stream" to the caller.
    return null;
  }
  if (name === undefined) return null;
  const sandbox = await Sandbox.get({ name });
  if (sandbox.tags?.sessionId !== sessionId) return null;
  const file = await sandbox.readFileToBuffer({ path: RELAY_TOKEN_FILE });
  if (file === null) return null;
  const { token } = JSON.parse(file.toString("utf8")) as { token: string };
  return { origin: sandbox.domain(RELAY_PORT).replace(/^http/, "ws"), token };
}

/**
 * The sandbox the session's latest live stream for `device` runs in, from that device's own
 * tools: the `screen` of a completed call, or the `live` a running call reports before it acts.
 * A call requested before `events` began is skipped; a wider window finds it.
 */
function latestSandbox(
  events: readonly SessionStreamEvent[],
  device: LiveDevice,
): string | undefined {
  const deviceCalls = new Set<string>();
  for (const event of events) {
    if (event.type !== "call.requested") continue;
    const { callId, capability } = event.data;
    if (capability.kind === "tool" && capability.name.startsWith(DEVICE_TOOL_PREFIX[device]))
      deviceCalls.add(callId);
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    let reported: unknown;
    if (event.type === "call.progress") {
      if (deviceCalls.has(event.data.callId)) reported = field(event.data.output, "live");
    } else if (event.type === "call.settled" && event.data.outcome === "completed") {
      if (deviceCalls.has(event.data.callId)) reported = field(event.data.output, "screen");
    }
    if (reported === undefined) continue;
    const reportedDevice = field(reported, "device");
    const sandbox = field(reported, "sandbox");
    if (reportedDevice === device && typeof sandbox === "string") return sandbox;
  }
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
