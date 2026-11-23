/**
 * Where the live streams listen in the sandbox, shared by the agent, which starts them, and the
 * web app's /api/live route, which connects viewers to them. See agent/lib/live.ts.
 */

/** The browser's relay, on a public sandbox port opened in agent/sandbox.ts. */
export const RELAY_PORT = 3600;

/**
 * screen-relay's own public port for the desktop, opened in agent/sandbox.ts. It requires its
 * token, which never leaves the server; viewers connect with a single-use ticket instead.
 */
export const DESKTOP_STREAM_PORT = 3601;

/** agent-browser's stream, which the relay forwards to. agent/sandbox.ts pins every session to it. */
export const BROWSER_STREAM_PORT = 3602;

/** The relay writes its token here; only code holding Vercel project credentials can read it. */
export const RELAY_TOKEN_FILE = "/tmp/live-relay.json";

export type LiveDevice = "browser" | "desktop";

/** The prefix of each device's tools, from the extension mounts in agent/extensions/. */
export const DEVICE_TOOL_PREFIX: Record<LiveDevice, string> = {
  browser: "browser__",
  desktop: "computer__",
};

export const HISTORY_ACTIONS = ["back", "forward", "reload"] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/** Longest URL the address bar may open. */
export const MAX_URL_LENGTH = 2048;

/**
 * What the address bar typed, as a URL to open, or null when it isn't an http(s) URL. Like a
 * browser's address bar, a bare host such as `example.com` gets `https://`.
 */
export function addressBarUrl(typed: string): string | null {
  const text = typed.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export type Control =
  | { readonly type: "history"; readonly action: HistoryAction }
  | { readonly type: "open"; readonly url: string }
  | { readonly type: "invalid" };

/**
 * The browser's own controls, which agent-browser's stream has no messages for:
 * `{ "type": "history", "action": "back" }` from the back, forward, and reload buttons, and
 * `{ "type": "open", "url": "…" }` from the address bar. Null for any other message, which goes
 * to the sandbox; a malformed control is dropped, never forwarded.
 */
export function controlMessage(text: string): Control | null {
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
