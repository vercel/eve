import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";
import { verifyRegistryInstall } from "./registry-install";

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod installs the official agent-browser extension instead of authoring browser tools.",
  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      const run = await selfMod.request("Can you add browser automation?");
      await verifyRegistryInstall({
        address: "extension/agent-browser",
        source: "registry/extensions/agent-browser.ts",
        target: "extensions/browser.ts",
        run,
        selfMod,
      });
      t.succeeded();
    });
  },
});
