import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

import { environment } from "../sandbox.js";
import { BROWSER_SESSION, FIND_STATE, SIGN_IN_SANDBOX } from "./browser.js";

/**
 * Loads the latest saved sign-ins into this meeting's browser. A meeting's
 * sandbox mounts the Drive as it was when the sandbox started, so sign-ins
 * saved since then are read from the sign-in sandbox instead.
 */
export async function reloadSignIns(ctx: Pick<ToolContext, "getSandbox">): Promise<void> {
  const { Sandbox } = await import("@vercel/sandbox");
  const source = await Sandbox.get({ name: SIGN_IN_SANDBOX });
  const read = await source.runCommand("bash", [
    "-lc",
    `${FIND_STATE}; [ -n "$state" ] && echo "$state" && base64 -w0 "$state"`,
  ]);
  if (read.exitCode !== 0)
    throw new Error("No sign-ins are saved yet. Share a sign-in link first.");
  const [saved = "", content = ""] = (await read.stdout()).split("\n");
  // Keep the extension: agent-browser decrypts a file whose name ends in `.enc`.
  const path = `/tmp/eve-sign-ins.${saved.endsWith(".enc") ? "json.enc" : "json"}`;
  const sandbox = await ctx.getSandbox(environment);
  await sandbox.writeBinaryFile({ path, content: Buffer.from(content, "base64") });
  // Loading state into a running browser only takes effect at its next
  // launch, so relaunch it with the file and reopen the page it was on.
  const options = { json: false, session: BROWSER_SESSION } as const;
  const { stdout: url } = await runAgentBrowser(ctx, ["get", "url"], options);
  await runAgentBrowser(
    ctx,
    ["--state", path, "--relaunch", "open", url.trim() || "about:blank"],
    options,
  );
  await runAgentBrowser(ctx, ["set", "viewport", "1280", "720"], options);
}
