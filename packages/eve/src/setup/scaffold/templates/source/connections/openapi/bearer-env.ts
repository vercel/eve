import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  spec: __EVE_OPENAPI_SPEC__,
  baseUrl: __EVE_OPENAPI_BASE_URL__,
  description: __EVE_CONNECTION_DESCRIPTION__,
  auth: { getToken: async () => ({ token: __EVE_BEARER_TOKEN__ }) },
});
