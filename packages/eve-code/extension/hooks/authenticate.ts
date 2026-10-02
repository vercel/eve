import { defineHook } from "eve/hooks";

import extension from "../extension.ts";
import { authenticateTurn } from "../lib/connect-authentication.ts";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await authenticateTurn(extension.config, () => ctx.getSandbox());
    },
  },
});
