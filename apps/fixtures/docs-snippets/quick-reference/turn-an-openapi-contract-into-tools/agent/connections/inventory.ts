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
  approval: ({ toolName }) =>
    toolName === "inventory__createOrder" ? "user-approval" : "not-applicable",
});
