import { randomBytes } from "node:crypto";

import { defineEval } from "eve/evals";

import { METADATA_TOOL, PROMPT, startChannelSession } from "./shared";

// The anchored channel's metadata has no `topic`, so the resolver
// returns null and no tool registers. The channel also adds its permanent
// address after the first reply; sending again through the initial address
// verifies that additive continuation hooks keep both addresses active.
export default defineEval({
  tags: ["real-model"],
  description:
    "Channel metadata smoke: missing topic takes the null path and alias preserves the initial address.",
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

    const resumedSessionId = await startChannelSession(t.target, "/anchor/start", {
      message: "Reply exactly: resumed through the initial address.",
      threadId,
    });
    if (resumedSessionId !== sessionId) {
      throw new Error(
        `Initial continuation address created ${resumedSessionId} instead of resuming ${sessionId}.`,
      );
    }

    t.succeeded();
    t.notCalledTool(METADATA_TOOL);
  },
});
