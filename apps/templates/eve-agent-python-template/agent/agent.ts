import { defineAgent } from "eve";

// A string model ID routes through Vercel AI Gateway. On Vercel, the deployment
// authenticates with project OIDC; locally, run `eve link` or set AI_GATEWAY_API_KEY.
export default defineAgent({
  limits: {
    sessionUsage: ({ window }) => window.inputTokens >= 300_000,
  },
  model: "anthropic/claude-sonnet-5",
});
