import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: __EVE_CONNECTION_URL__,
  description: __EVE_CONNECTION_DESCRIPTION__,
  headers: () => __EVE_HEADERS__,
});
