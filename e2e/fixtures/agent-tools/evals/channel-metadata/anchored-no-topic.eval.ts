import { randomBytes } from "node:crypto";

import { defineEval } from "eve/evals";

import { METADATA_TOOL, PROMPT, extractToolOutput, startChannelSession } from "./shared.js";

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
    const output = extractToolOutput(session.events, METADATA_TOOL);
    if (output !== undefined) {
      throw new Error(
        "The anchored channel sets no `topic`, so the resolver should return null and " +
          `register no tool; saw a ${METADATA_TOOL} result: ${JSON.stringify(output)}`,
      );
    }

    const failedActions = session.events.filter(
      (event) =>
        event.type === "action.result" &&
        (event.data.status === "failed" || event.data.result.isError === true),
    );
    if (failedActions.length > 0) {
      throw new Error(`Expected no failed actions; saw ${failedActions.length}.`);
    }

    t.didNotFail();
    t.completed();
    t.notCalledTool(METADATA_TOOL);
  },
});
