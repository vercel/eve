/**
 * Where the live view's relay listens in the sandbox, shared by the agent, which starts it, and
 * the web app's /api/live route, which connects to it. See agent/lib/live.ts.
 */

/** The sandbox's one public port, opened in agent/sandbox.ts. Only the relay listens on it. */
export const RELAY_PORT = 3600;

/** The relay writes its token here; only code holding Vercel project credentials can read it. */
export const RELAY_TOKEN_FILE = "/tmp/live-relay.json";

/** Bump when RELAY_SOURCE changes, so sandboxes running an older relay restart it. */
export const RELAY_VERSION = "4";

export type LiveDevice = "browser" | "desktop";

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
