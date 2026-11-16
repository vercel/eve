import { defineChannel, POST } from "eve/channels";
import { handleInvestigationWebhook } from "#lib/webhook/route.ts";
import slack from "./slack.ts";

export default defineChannel({
  routes: [
    POST("/v1/investigate", async (request, args) =>
      handleInvestigationWebhook(request, args, slack)
    ),
  ],
});
