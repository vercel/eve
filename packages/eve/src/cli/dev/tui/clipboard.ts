import { spawn } from "node:child_process";

export function clipboardSequence(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
  const multiplexed = env.TMUX !== undefined || env.STY !== undefined;
  return multiplexed ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence;
}

export function clipboardCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] | undefined {
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "linux") {
    return env.WAYLAND_DISPLAY !== undefined ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
  }
  if (platform === "win32") return ["clip"];
  return undefined;
}

export function copyTextToClipboard(text: string, writeTerminal: (chunk: string) => void): void {
  writeTerminal(clipboardSequence(text));
  const command = clipboardCommand(process.platform);
  if (command === undefined) return;
  try {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ["pipe", "ignore", "ignore"],
      detached: false,
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  } catch {}
}
