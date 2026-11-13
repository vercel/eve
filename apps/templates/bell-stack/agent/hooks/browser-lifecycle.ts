import { defineHook } from "eve/hooks";

import { saveBrowserRuntime } from "../lib/browser-runtime";

export default defineHook({
  events: {
    async "turn.completed"(_event, ctx) {
      await saveBrowserRuntime(ctx.session.id);
    },
  },
});
