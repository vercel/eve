import { defineOpenAPIConnection } from "eve/connections";
import spec from "../../inventory-openapi.json";

export default defineOpenAPIConnection({
  spec,
  baseUrl: "https://api.example.com",
  description: "Inventory lookups and purchase orders.",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: process.env.INVENTORY_API_TOKEN! }),
  },
  operations: { allow: ["getStock", "createOrder"] },
  approval: ({ toolName, toolInput }) => {
    if (toolName !== "inventory__createOrder") return "not-applicable";
    const body = toolInput?.body as { quantity?: number; unitCost?: number } | undefined;
    return (body?.quantity ?? 0) * (body?.unitCost ?? 0) >= 1000
      ? "user-approval"
      : "not-applicable";
  },
});
