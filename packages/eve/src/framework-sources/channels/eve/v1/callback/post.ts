import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { handleSessionCallbackRequest } from "#runtime/session-callback-route.js";

export default () =>
  defineChannel({
    routes: [POST(EVE_CALLBACK_ROUTE_PATTERN, handleSessionCallbackRequest)],
  });
