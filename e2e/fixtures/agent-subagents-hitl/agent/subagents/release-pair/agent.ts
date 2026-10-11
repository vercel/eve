import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export const RELEASE_PAIR_MARKER = "RELEASE-PAIR-DONE-4T8Q";

export default defineAgent({
  description: "Deploy a release and publish its notes, asking for approval of each.",
  // Both gated calls in one step, so the parent relays two approvals at once.
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return {
        toolCalls: [
          { input: {}, name: "deploy_release" },
          { input: {}, name: "publish_notes" },
        ],
      };
    }
    const outputs = toolResults.map((result) => `${result.name}=${JSON.stringify(result.output)}`);
    return `${RELEASE_PAIR_MARKER} ${outputs.join(" ")}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
