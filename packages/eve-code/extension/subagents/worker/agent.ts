import { defineAgent, defineDynamic } from "eve";

import extension from "../../extension.ts";

export default defineAgent({
  description:
    "Another mind for one scoped slice. Give it a self-contained question and choose the lifetime: keep it and send deltas when it should own the slice end to end, or ask once. It can see the shared tree. You remain the arbiter and keep the writes.",
  model: defineDynamic({
    events: {
      "session.started": () => {
        const worker = extension.config.worker ?? {
          model: "openai/gpt-5.6-terra-fast",
          reasoning: "xhigh",
        };
        return {
          model: worker.model,
          reasoning: worker.reasoning,
          modelOptions:
            worker.openaiReasoningEffort === undefined
              ? undefined
              : {
                  providerOptions: {
                    openai: {
                      reasoningEffort: worker.openaiReasoningEffort,
                    },
                  },
                },
        };
      },
    },
  }),
  reasoning: "xhigh",
  defaultTools: false,
});
