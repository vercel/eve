import { defineAgent, defineDynamic } from "eve";

import extension from "../../extension.ts";

export default defineDynamic({
  events: {
    "turn.started": () =>
      extension.config.eveGh?.enabled === true
        ? defineAgent({
            defaultTools: false,
            description:
              "Work on the configured repository in an isolated sandbox with Sandbox-managed Git credentials and signed pushes. Give a self-contained coding task; this checkout is separate from the parent's workspace.",
            model: extension.config.worker?.model ?? "openai/gpt-5.6-terra-fast",
            reasoning: extension.config.worker?.reasoning ?? "xhigh",
          })
        : null,
  },
});
