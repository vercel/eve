import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

import { environment } from "../sandbox.js";
import { BROWSER_SESSION, SIGN_IN_SANDBOX, STATE_FILE } from "./browser.js";

/**
 * Loads the latest saved sign-ins into this meeting's browser. A meeting's
 * sandbox mounts the Drive as it was when the sandbox started, so sign-ins
 * saved since then are read from the sign-in sandbox instead.
 */
export async function reloadSignIns(ctx: Pick<ToolContext, "getSandbox">): Promise<void> {
  const { Sandbox } = await import("@vercel/sandbox");
  const source = await Sandbox.get({ name: SIGN_IN_SANDBOX });
  const read = await source.runCommand("bash", ["-lc", `base64 -w0 ${STATE_FILE}`]);
  if (read.exitCode !== 0)
    throw new Error("No sign-ins are saved yet. Share a sign-in link first.");
  const path = "/tmp/eve-sign-ins.json";
  const sandbox = await ctx.getSandbox(environment);
  await sandbox.writeBinaryFile({ path, content: Buffer.from(await read.stdout(), "base64") });
  await runAgentBrowser(ctx, ["state", "load", path], { session: BROWSER_SESSION });
}
