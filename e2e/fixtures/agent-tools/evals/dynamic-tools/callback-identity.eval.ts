import { defineEval } from "eve/evals";

import { startChannelSession } from "../channel-metadata/shared";

const message = "Call the `callback_identity` tool and report its implementation and topic.";

export default defineEval({
  description:
    "Dynamic callbacks keep their session's implementation when another session registers the same tool name.",
  async test(t) {
    const guardedId = await startChannelSession(t.target, "/metadata-provider/start", {
      message,
      topic: "callback-guarded",
    });
    const guarded = await t.target.attachSession(guardedId);
    guarded.succeeded();
    guarded.calledTool("callback_identity", {
      output: { implementation: "guarded", topic: "callback-guarded" },
    });

    const openId = await startChannelSession(t.target, "/metadata-provider/start", {
      message,
      topic: "callback-open",
    });
    const open = await t.target.attachSession(openId);
    open.succeeded();
    open.calledTool("callback_identity", {
      output: { implementation: "open", topic: "callback-open" },
    });

    const replayed = await guarded.send(message);
    replayed.expectOk();
    replayed.calledTool("callback_identity", {
      output: { implementation: "guarded", topic: "callback-guarded" },
    });
  },
});
