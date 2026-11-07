import { upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";

import {
  addressBarUrl,
  HISTORY_ACTIONS,
  type HistoryAction,
  type LiveDevice,
} from "../../../../../agent/lib/live-config";
import { findRelay, type Relay } from "./relay";

export const dynamic = "force-dynamic";

/** Input sent before the sandbox side opens is held, up to this many messages. */
const MAX_PENDING = 100;

/**
 * The live view's WebSocket: `/api/live?session=<eve session>&device=browser|desktop`. It checks
 * that the caller may read the session, then relays frames out and input in between the browser
 * and the sandbox. The browser never learns the sandbox's address or the relay's token.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const session = params.get("session");
  const device = params.get("device");
  if (session === null || session.length === 0 || session.length > 512 || !isDevice(device)) {
    return new Response("Expected ?session=<id>&device=browser|desktop", { status: 400 });
  }

  let relay: Relay | null;
  try {
    relay = await findRelay(request, session, device);
  } catch (error) {
    console.error("Finding the live view relay failed:", error);
    relay = null;
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
        `${origin}/${device}?token=${encodeURIComponent(token)}&maxFps=24`,
      );
      const pending: string[] = [];
      const closeBoth = () => {
        client.close();
        upstream.close();
      };

      upstream.on("open", () => {
        for (const message of pending.splice(0)) upstream.send(message);
      });
      upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
      upstream.on("close", closeBoth);
      upstream.on("error", closeBoth);

      client.on("message", (data) => {
        const text = data.toString();
        const control = controlMessage(text);
        if (control !== null) {
          if (device === "browser") void runControl(relay, control);
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

function isDevice(value: string | null): value is LiveDevice {
  return value === "browser" || value === "desktop";
}

type Control =
  | { readonly type: "history"; readonly action: HistoryAction }
  | { readonly type: "open"; readonly url: string }
  | { readonly type: "invalid" };

/**
 * The browser's own controls, which agent-browser's stream has no messages for:
 * `{ "type": "history", "action": "back" }` from the back, forward, and reload buttons, and
 * `{ "type": "open", "url": "…" }` from the address bar. Null for any other message, which goes
 * to the sandbox; a malformed control is dropped, never forwarded.
 */
function controlMessage(text: string): Control | null {
  if (!text.includes('"history"') && !text.includes('"open"')) return null;
  let message: { type?: unknown; action?: unknown; url?: unknown };
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    return null;
  }
  if (message.type === "history") {
    const action = HISTORY_ACTIONS.find((candidate) => candidate === message.action);
    return action === undefined ? { type: "invalid" } : { type: "history", action };
  }
  if (message.type === "open") {
    const url = typeof message.url === "string" ? addressBarUrl(message.url) : null;
    return url === null ? { type: "invalid" } : { type: "open", url };
  }
  return null;
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
