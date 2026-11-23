import { upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";

import { controlMessage, type Control } from "../../../../../agent/lib/live-config";
import { getViewer } from "../../../lib/session";
import { isSameOrigin } from "../../../lib/origin";
import { browserRelay, desktopTicket, findSandbox, type Relay } from "./relay";

export const dynamic = "force-dynamic";

/** Input sent before the sandbox side opens is held, up to this many messages. */
const MAX_PENDING = 100;

function sessionParam(request: Request): string | null {
  const session = new URL(request.url).searchParams.get("session");
  return session === null || session.length === 0 || session.length > 512 ? null : session;
}

/**
 * The browser's live view: `GET /api/live?session=<eve session>` as a WebSocket. It checks that
 * the caller may read the session, then relays frames out and input in between the page and
 * agent-browser's stream in the session's sandbox. The page never learns the sandbox's address or
 * the relay's token.
 */
export async function GET(request: Request) {
  const session = sessionParam(request);
  if (session === null) return new Response("Expected ?session=<id>", { status: 400 });

  let relay: Relay | null = null;
  try {
    if (isSameOrigin(request) && getViewer(request.headers) !== null) {
      const sandbox = await findSandbox(request, session);
      relay = sandbox === null ? null : await browserRelay(sandbox);
    }
  } catch (error) {
    console.error("Finding the live view relay failed:", error);
  }
  // Authorized before anything is sent. A refused WebSocket is accepted and closed with a policy
  // code rather than answered with an HTTP error, which the client can't read anyway and which
  // crashes `vercel dev`'s proxy when the client has already gone.
  if (relay === null)
    return upgradeWebSocket((client) => client.close(1008, "No live view for this session."));
  const { origin, token } = relay;

  return upgradeWebSocket(
    (client) => {
      const upstream = new WebSocket(
        `${origin}/browser?token=${encodeURIComponent(token)}&maxFps=24`,
      );
      const pending: string[] = [];
      const closeBoth = () => {
        client.close();
        upstream.close();
      };

      upstream.on("open", () => {
        for (const text of pending.splice(0)) upstream.send(text);
      });
      upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
      upstream.on("close", closeBoth);
      upstream.on("error", closeBoth);

      client.on("message", (raw) => {
        const text = raw.toString();
        const control = controlMessage(text);
        if (control !== null) {
          void runControl(relay, control);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else if (upstream.readyState === WebSocket.CONNECTING && pending.length < MAX_PENDING)
          pending.push(text);
      });
      client.on("close", closeBoth);
      client.on("error", closeBoth);
    },
    // Input events are small; a paste is sent a character at a time.
    { maxPayload: 64 * 1024 },
  );
}

/**
 * The desktop's live view: `POST /api/live?session=<eve session>` answers
 * `{ "url": "wss://…/stream", "ticket": "…" }` when the caller may read the session. The page
 * connects to screen-relay with the ticket, which opens one connection within 60 seconds.
 */
export async function POST(request: Request) {
  const session = sessionParam(request);
  if (session === null) return Response.json({ error: "Expected ?session=<id>" }, { status: 400 });
  if (!isSameOrigin(request))
    return Response.json({ error: "Cross-site requests are refused." }, { status: 403 });
  if (getViewer(request.headers) === null)
    return Response.json({ error: "Sign in first." }, { status: 401 });
  try {
    const sandbox = await findSandbox(request, session);
    const ticket = sandbox === null ? null : await desktopTicket(sandbox);
    if (ticket !== null) return Response.json(ticket, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Issuing a desktop stream ticket failed:", error);
  }
  return Response.json({ error: "No live view for this session." }, { status: 404 });
}

/** The relay runs these with agent-browser in the sandbox. */
async function runControl({ origin, token }: Relay, control: Control): Promise<void> {
  if (control.type === "invalid") return;
  const base = `${origin.replace(/^ws/, "http")}/browser`;
  const url =
    control.type === "history"
      ? `${base}/navigate?token=${encodeURIComponent(token)}&action=${control.action}`
      : `${base}/open?token=${encodeURIComponent(token)}&url=${encodeURIComponent(control.url)}`;
  await fetch(url, { method: "POST" }).catch((error: unknown) =>
    console.warn("Browser control failed:", error),
  );
}
