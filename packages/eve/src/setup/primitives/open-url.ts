import { spawn } from "node:child_process";

/** The OS command that opens a URL in the default browser, per platform. */
function osOpenCommand(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Parses a candidate string into a normalized web URL, or `undefined` if it is
 * not a valid `http(s)` URL. Uses the URL parser rather than a pattern so the
 * accept/reject decision matches what a browser would resolve.
 */
export function parseWebUrl(candidate: string): string | undefined {
  const parsed = URL.parse(candidate.trim());
  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.href;
  }
  return undefined;
}

/**
 * Opens a URL in the user's default browser, best-effort and fire-and-forget.
 * Used where eve owns the hand-off (e.g. pointing the user at their Slack
 * workspace after a deploy) rather than relying on a child CLI to open it. A
 * missing or failing opener is never fatal: callers still print the URL for the
 * user to open by hand.
 */
export function openUrl(url: string): void {
  // Only ever hand the OS opener a real web URL, never an arbitrary scheme or
  // a shell-significant argument.
  if (parseWebUrl(url) === undefined) return;
  const { command, args } = osOpenCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The opener is a convenience; its absence must not break the flow.
  }
}
