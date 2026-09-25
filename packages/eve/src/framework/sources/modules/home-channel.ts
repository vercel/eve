import { defineChannel, GET, HEAD } from "#public/definitions/channel.js";
import { buildHomePageResponse } from "#internal/nitro/routes/index.js";
import { readHomeRouteMetadata } from "#internal/nitro/routes/channel-route-context.js";

const respond = async (request: Request, args: Parameters<typeof readHomeRouteMetadata>[0]) =>
  buildHomePageResponse(readHomeRouteMetadata(args) ?? { agentName: "eve" }, request);

export default defineChannel({
  routes: [GET("/", respond), HEAD("/", respond)],
});
