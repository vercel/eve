import { randomBytes } from "node:crypto";

import { defineEval } from "eve/evals";

import { METADATA_TOOL, PROMPT, startChannelSession } from "./shared";

// The anchored channel's metadata has no `topic`, so the resolver
// returns null and no tool registers: the turn completes without a
// dynamic-channel-metadata result and without failures.
export default defineEval({
  description: "Channel metadata smoke: missing topic metadata takes the null-resolve path.",
  async test(t) {
    const threadId = `thread-${randomBytes(4).toString("hex")}`;
    const sessionId = await startChannelSession(t.target, "/anchor/start", {
      message: PROMPT,
      threadId,
    });

    const session = await t.target.attachSession(sessionId);
    session.succeeded();
    session.notCalledTool(METADATA_TOOL);
    session.noFailedActions();

    t.succeeded();
    t.notCalledTool(METADATA_TOOL);
  },
});
