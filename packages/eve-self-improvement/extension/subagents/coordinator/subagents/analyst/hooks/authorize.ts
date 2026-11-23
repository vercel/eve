import { defineHook } from "eve/hooks";
import extension from "../../../../../extension.js";
import { authorizeAnalyst } from "../../../../../lib/delegation.js";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await authorizeAnalyst(extension.config, ctx);
    },
  },
});
