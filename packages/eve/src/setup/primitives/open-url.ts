import { spawn } from "node:child_process";

function osOpenCommand(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export function parseWebUrl(candidate: string): string | undefined {
  const parsed = URL.parse(candidate.trim());
  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.href;
  }
  return undefined;
}

export function openUrl(url: string): void {
  const webUrl = parseWebUrl(url);
  if (webUrl === undefined) return;
  const { command, args } = osOpenCommand(webUrl);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
