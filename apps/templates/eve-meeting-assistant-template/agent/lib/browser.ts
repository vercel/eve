// eve's browser is agent-browser's headless Chromium in the sandbox. Sign-ins
// an admin saves at `/meeting/browser-sign-in` live in one agent-browser
// state file on a Vercel Drive, which every meeting's sandbox mounts as a
// read-only snapshot and loads when its browser starts.

/** The agent-browser session the tools, the screen share, and the sign-in page use. */
export const BROWSER_SESSION = "meeting";

/** agent-browser streams frames and takes input on this local port. */
export const STREAM_PORT = 9223;

/** The sandbox port the bridge serves the browser view on; Vercel gives it a public HTTPS domain. */
export const BRIDGE_PORT = 3000;

export const SIGN_INS_DRIVE =
  process.env.MEETING_BROWSER_DRIVE?.trim() || "meeting-browser-sign-ins";

/** Drives live in one region, and sandboxes that mount them must run there too. */
export const REGION = (process.env.MEETING_BROWSER_REGION?.trim() || "iad1") as "iad1";

export const SIGN_INS_DIR = "/sign-ins";
export const STATE_FILE = `${SIGN_INS_DIR}/state.json`;

/** Environment for every sandbox that runs the browser. */
export function browserEnv(): Record<string, string> {
  const env: Record<string, string> = { AGENT_BROWSER_STREAM_PORT: String(STREAM_PORT) };
  // Encrypts the saved sign-ins at rest. Both kinds of sandbox need the same key.
  const key = process.env.MEETING_BROWSER_ENCRYPTION_KEY?.trim();
  if (key) env.AGENT_BROWSER_ENCRYPTION_KEY = key;
  return env;
}

/** The Drive of saved sign-ins as a read-only snapshot, or `undefined` before anyone signed in. */
export async function signInsSnapshot(): Promise<{ drive: string; mode: "snapshot" } | undefined> {
  const { Drive } = await import("@vercel/sandbox");
  try {
    return (await Drive.get({ name: SIGN_INS_DRIVE })).snapshot();
  } catch (error) {
    if (error instanceof Error && /not.?found|404/iu.test(error.message)) return undefined;
    throw error;
  }
}
