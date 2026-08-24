import { EVE_CONNECTION_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { handleConnectionCallbackRequest } from "#runtime/connections/callback-route.js";

export default () =>
  defineChannel({
    routes: [POST(EVE_CONNECTION_CALLBACK_ROUTE_PATTERN, handleConnectionCallbackRequest)],
  });
