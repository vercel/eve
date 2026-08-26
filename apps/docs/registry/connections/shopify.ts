import { randomUUID } from "node:crypto";
import { defineMcpClientConnection } from "eve/connections";

// Replace Shopify's example with your hosted UCP agent profile before production.
const agentProfileUrl =
  process.env.UCP_AGENT_PROFILE_URL ||
  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json";

export default defineMcpClientConnection({
  url: `https://${process.env.SHOPIFY_STORE_DOMAIN!}/api/ucp/mcp`,
  description: "Search products and build carts and checkouts on a Shopify storefront.",
  toolCall: {
    providedArguments: {
      meta: ({ toolName }) => ({
        "ucp-agent": {
          profile: agentProfileUrl,
        },
        // Shopify requires a unique idempotency key for destructive and finalizing calls.
        ...(["cancel_cart", "complete_checkout", "cancel_checkout"].includes(toolName)
          ? { "idempotency-key": randomUUID() }
          : {}),
      }),
    },
  },
});
