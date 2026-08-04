import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  spec: __EVE_OPENAPI_SPEC__,
  baseUrl: __EVE_OPENAPI_BASE_URL__,
  description: __EVE_CONNECTION_DESCRIPTION__,
  headers: () => __EVE_HEADERS__,
});
