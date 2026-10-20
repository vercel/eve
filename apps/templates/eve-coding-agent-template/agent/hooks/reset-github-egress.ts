import { defineHook } from "eve/hooks";

import { brokerGitHubLease } from "../lib/github";

// The GitHub channel's checkout leaves its installation token attached to all
// of github.com. Hooks run after the channel's `turn.started` handler, so this
// clears it before the model runs. Only `git__gh` leases then carry credentials.
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      if (ctx.channel.kind !== "github") return;
      try {
        await brokerGitHubLease(await ctx.getSandbox(), null);
      } catch (error) {
        // Fail closed: a turn must not run with the broad token still attached.
        ctx.cancel();
        throw error;
      }
    },
  },
});
