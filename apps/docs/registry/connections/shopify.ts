import { defineMcpClientConnection } from "eve/connections";

const SHOPIFY_EXAMPLE_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json";

// Shopify cannot reach localhost. Use its public profile, or expose this route with a tool like ngrok.
function agentProfileUrl(): string {
  if (process.env.EVE_DEV === "1") return SHOPIFY_EXAMPLE_PROFILE;

  return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/.well-known/ucp`;
}

export default defineMcpClientConnection({
  url: `https://${process.env.SHOPIFY_STORE_DOMAIN!}/api/ucp/mcp`,
  description: "Search products and build carts and checkouts on a Shopify storefront.",
  toolCall: {
    providedArguments: {
      meta: ({ callId, session, toolName }) => ({
        "ucp-agent": {
          profile: agentProfileUrl(),
        },

        // These calls require a unique idempotency key.
        ...(["cancel_cart", "complete_checkout", "cancel_checkout"].includes(toolName)
          ? {
              "idempotency-key": `${session.id}:${session.turn.id}:${toolName}:${callId}`,
            }
          : {}),
      }),
    },
  },
});
