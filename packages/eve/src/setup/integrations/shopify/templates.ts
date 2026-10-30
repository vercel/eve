export const SHOPIFY_UCP_CHANNEL_TEMPLATE = `import { defineChannel, GET } from "eve/channels";

const profile = {
  ucp: {
    version: "2026-08-25",
    services: {
      "dev.ucp.shopping": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/overview",
          transport: "mcp",
          schema: "https://ucp.dev/2026-08-25/services/shopping/mcp.openrpc.json",
        },
      ],
    },
    capabilities: {
      "dev.ucp.shopping.checkout": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/shopping/checkout",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json",
        },
      ],
      "dev.ucp.shopping.fulfillment": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/shopping/extensions/fulfillment",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/fulfillment.json",
          extends: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.cart"],
        },
      ],
      "dev.ucp.shopping.buyer_consent": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/shopping/extensions/buyer-consent",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/buyer_consent.json",
          extends: "dev.ucp.shopping.checkout",
        },
      ],
      "dev.ucp.shopping.discount": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/shopping/extensions/discount",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/discount.json",
          extends: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.cart"],
        },
      ],
      "dev.ucp.shopping.cart": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/cart",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/cart.json",
        },
      ],
      "dev.ucp.shopping.catalog.search": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/catalog/search",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_search.json",
        },
      ],
      "dev.ucp.shopping.catalog.lookup": [
        {
          version: "2026-08-25",
          spec: "https://ucp.dev/2026-08-25/specification/catalog/lookup",
          schema: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_lookup.json",
        },
      ],
      "dev.shopify.catalog": [
        {
          version: "2026-08-25",
          spec: "https://shopify.dev/docs/agents/catalog/storefront-catalog",
          schema: "https://shopify.dev/ucp/schemas/2026-08-25/shopify_catalog.json",
          extends: [
            "dev.ucp.shopping.catalog.lookup",
            "dev.ucp.shopping.catalog.search",
          ],
        },
      ],
    },
    payment_handlers: {},
  },
};

const body = JSON.stringify(profile);

export default defineChannel({
  cors: true,
  routes: [
    GET("/.well-known/ucp", async () => {
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
        },
      });
    }),
  ],
});
`;
