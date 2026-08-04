import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: __EVE_CONNECTION_URL__,
  description: __EVE_CONNECTION_DESCRIPTION__,
  auth: { getToken: async () => ({ token: __EVE_BEARER_TOKEN__ }) },
});
