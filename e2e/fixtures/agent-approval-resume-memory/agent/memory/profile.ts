import { defineMemory } from "eve/memory";

export default defineMemory({
  description: "Empty recall reproducer for approval resume ordering.",
  provider: {
    recall: {
      "turn.started": async () => ({ messages: [] }),
    },
  },
  scope: "approval-resume-e2e",
});
