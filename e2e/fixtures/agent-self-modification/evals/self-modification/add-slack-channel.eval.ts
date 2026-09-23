import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";
import { verifyRegistryHandoff } from "./registry-install";

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod discovers the official Slack channel and hands its required setup to the terminal.",
  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      const run = await selfMod.request("Can you add the slack channel?");
      await verifyRegistryHandoff({ address: "channel/slack", run, selfMod });
    });
  },
});
