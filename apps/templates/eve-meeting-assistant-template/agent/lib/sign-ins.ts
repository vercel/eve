import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

import { BROWSER_SESSION, FIND_STATE, SIGN_IN_SANDBOX } from "./browser.js";

// Saved sign-ins live with the sign-in sandbox, on a Drive it mounts
// read-write. Meetings copy them from that sandbox: a Drive snapshot doesn't
// show writes from a sandbox that still has the Drive mounted.

/** Where a meeting's sandbox keeps its copy. agent-browser decrypts a file whose name ends in `.enc`. */
const LOCAL = "/tmp/eve-sign-ins.json";

/** Shell that points agent-browser's next launch at the meeting's copy, when there is one. */
const USE_LOCAL = `for f in ${LOCAL}.enc ${LOCAL}; do [ -f "$f" ] && { mkdir -p ~/.agent-browser && printf '{"state":"%s"}' "$f" > ~/.agent-browser/config.json; break; }; done`;

interface Target {
  writeBinaryFile(options: { path: string; content: Uint8Array }): PromiseLike<void>;
  run(options: { command: string }): PromiseLike<{ exitCode: number }>;
}

/** Copies the latest saved sign-ins into a sandbox, and returns the path, or `undefined` when none are saved. */
export async function copySignIns(target: Target): Promise<string | undefined> {
  const { Sandbox } = await import("@vercel/sandbox");
  let source;
  try {
    source = await Sandbox.get({ name: SIGN_IN_SANDBOX });
  } catch {
    return undefined;
  }
  const read = await source.runCommand("bash", [
    "-lc",
    `${FIND_STATE}; [ -n "$state" ] && echo "$state" && base64 -w0 "$state"`,
  ]);
  if (read.exitCode !== 0) return undefined;
  const [saved = "", content = ""] = (await read.stdout()).split("\n");
  const path = saved.endsWith(".enc") ? `${LOCAL}.enc` : LOCAL;
  await target.writeBinaryFile({ path, content: Buffer.from(content, "base64") });
  await target.run({ command: USE_LOCAL });
  return path;
}

/** Loads the latest saved sign-ins into a running browser, which only reads them at launch. */
export async function reloadSignIns(
  ctx: Pick<ToolContext, "getSandbox">,
  target: Target,
): Promise<void> {
  const path = await copySignIns(target);
  if (path === undefined) throw new Error("No sign-ins are saved yet. Share a sign-in link first.");
  const options = { json: false, session: BROWSER_SESSION } as const;
  const { stdout: url } = await runAgentBrowser(ctx, ["get", "url"], options);
  await runAgentBrowser(
    ctx,
    ["--state", path, "--relaunch", "open", url.trim() || "about:blank"],
    options,
  );
  await runAgentBrowser(ctx, ["set", "viewport", "1280", "720"], options);
}
