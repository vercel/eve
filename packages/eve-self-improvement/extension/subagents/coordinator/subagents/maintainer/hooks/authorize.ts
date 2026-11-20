import { defineHook } from "eve/hooks";
import extension from "../../../../../extension.js";
import { authorizedActive } from "../../../../../lib/publish.js";
import { store } from "../../../../../lib/store.js";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await authorizedActive(extension.config, ctx);
    },
    async "turn.settled"(_event, ctx) {
      const active = await store(extension.config).active();
      if (active?.experiment?.writerSession === ctx.session.id)
        await (await ctx.getSandbox()).stop();
    },
  },
});
