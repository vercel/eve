import { defineHook } from "eve/hooks";
import { registerBackgroundReplyTarget } from "@agent/lib/reply-targets";
import { startedBrowserTaskId } from "@agent/lib/browser-task";

export default defineHook({
  events: {
    "call.started"(event, context) {
      const taskId = startedBrowserTaskId(event, context.view);
      if (!taskId) return;
      registerBackgroundReplyTarget(taskId, context.session.auth);
    },
  },
});
