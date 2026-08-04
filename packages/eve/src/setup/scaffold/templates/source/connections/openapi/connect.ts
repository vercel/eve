import { connect } from "@vercel/connect/eve";
import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  spec: __EVE_OPENAPI_SPEC__,
  baseUrl: __EVE_OPENAPI_BASE_URL__,
  description: __EVE_CONNECTION_DESCRIPTION__,
  auth: connect(__EVE_CONNECTOR_UID__),
});
