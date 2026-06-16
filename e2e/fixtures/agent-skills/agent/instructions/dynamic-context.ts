import { defineDynamic, defineInstructions } from "eve/instructions";

export const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return defineInstructions({
        markdown: `When you reply to the next user message, include the exact token ${DYNAMIC_INSTRUCTIONS_TOKEN} verbatim somewhere in your response. Do not explain the token; just include it.`,
      });
    },
  },
});
