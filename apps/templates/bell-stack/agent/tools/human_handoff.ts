import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { issueBrowserHandoffUrl } from "../../server/browser/handoff.js";
import { saveBrowserRuntime } from "../lib/browser-runtime";
import { taskState } from "../lib/task-state";

const HANDOFF_TTL_MS = 10 * 60 * 1_000;

export default defineTool({
  description:
    "Create a short-lived Browserbase Live View link when the user must act in the current browser, such as completing an OTP, login, CAPTCHA, passkey, or other human-only step. The browser must already be running. After this tool returns, print the complete raw handoff URL on its own line, never hide it in Markdown link syntax, ask the user to reply done, and end the turn.",
  inputSchema: z.object({
    reason: z.enum(["otp", "login", "captcha", "passkey", "other"]),
  }),
  async execute({ reason }, ctx) {
    ctx.abortSignal.throwIfAborted();
    await saveBrowserRuntime(ctx.session.id);
    const browserSessionId = taskState.get().browser.sessionId;
    if (!browserSessionId) {
      throw new Error(
        "No hosted browser is available for handoff. Open the required page with a browser tool first.",
      );
    }

    const handoffUrl = issueBrowserHandoffUrl(
      {
        eveSessionId: ctx.session.id,
        browserSessionId,
      },
      { ttlMs: HANDOFF_TTL_MS },
    );

    return {
      status: "waiting_for_user" as const,
      reason,
      handoffUrl,
      expiresInSeconds: HANDOFF_TTL_MS / 1_000,
      action:
        "Print the complete raw handoffUrl on its own line. Never use Markdown link syntax or replace the URL with a label. Ask the user to open it, complete the requested browser step, and reply done. End this turn without closing or replacing the browser.",
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
