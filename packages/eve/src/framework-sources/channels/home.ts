import { GET, defineChannel } from "#public/definitions/channel.js";
import { buildHomePageResponse } from "#framework-sources/channels/home-page.js";
import { readRouteAgentName } from "#channel/route-context.js";

export default () =>
  defineChannel({
    routes: [
      GET("/", async (request, args) => {
        const agentName = readRouteAgentName(args);
        if (agentName === undefined) {
          throw new Error("The framework home channel requires the resolved agent name.");
        }
        return buildHomePageResponse({ agentName }, request);
      }),
    ],
  });
