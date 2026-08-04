import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: __EVE_CONNECTION_URL__,
  description: __EVE_CONNECTION_DESCRIPTION__,
  auth: connect(__EVE_CONNECTOR_UID__),
});
