import { defineOpenAPIConnection } from "eve/connections";
import spec from "../../inventory-openapi.json";

export default defineOpenAPIConnection({
  spec,
  baseUrl: "https://api.example.com",
  description: "Inventory lookups and purchase orders.",
});
