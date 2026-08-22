import { EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import { defineChannel, GET } from "#public/definitions/channel.js";
import { handleLegacyConnectionCallbackRequest } from "#runtime/connections/callback-route.js";

export default () =>
  defineChannel({
    routes: [
      GET(EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN, handleLegacyConnectionCallbackRequest),
    ],
  });
