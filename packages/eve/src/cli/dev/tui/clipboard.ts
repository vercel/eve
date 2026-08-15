/**
 * Best-effort clipboard writes for the dev TUI: an OSC 52 escape sequence
 * (which reaches the user's terminal even over SSH, with tmux/screen
 * passthrough) plus the platform's native clipboard command as a fallback
 * for terminals that reject OSC 52. Both paths fail silently — copying is
 * a convenience, never a hard dependency.
 */

import { spawn } from "node:child_process";

/** The OSC 52 sequence for `text`, wrapped for tmux/screen when present. */
export function clipboardSequence(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
  const multiplexed = env.TMUX !== undefined || env.STY !== undefined;
  return multiplexed ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence;
}

/** The native clipboard command for a platform, or `undefined` when unknown. */
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

/**
 * Copies `text` to the clipboard: emits OSC 52 through `writeTerminal`
 * (the same raw write the alt screen paints with) and pipes the text into
 * the platform clipboard command in the background.
 */
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
  } catch {
    // Native clipboard is a fallback; OSC 52 already went out.
  }
}
