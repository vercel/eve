import { GET } from "eve/channels";
import { localDev, vercelOidc } from "eve/channels/auth";
import { defaultSlackAuth, slackChannel, type SlackChannel } from "eve/channels/slack";

import {
  SLACK_SESSION_ROUTE,
  slackApiStub,
  slackColdStartGuidance,
  verifySlackWebhook,
} from "../lib/slack-cold-start";

// eve's Slack channel against a stubbed Slack, for the Slack cold-start eval
// (lib/slack-cold-start.ts). The message hook is eve's default plus guidance
// that carries the webhook's arrival time to the model.
const slack = slackChannel({
  api: { fetch: slackApiStub },
  credentials: { botToken: "xoxb-slack-cold-start", webhookVerifier: verifySlackWebhook },
  onAppMention: (ctx, message) => ({
    auth: defaultSlackAuth(message, ctx),
    guidance: slackColdStartGuidance(message),
  }),
});

const authenticators = [vercelOidc(), localDev()];

const channel: SlackChannel = {
  ...slack,
  routes: [
    ...slack.routes,
    // The session a Slack thread started: eve's own lookup, for the eval to read the turn.
    GET(SLACK_SESSION_ROUTE, async (request, { resolveSession }) => {
      const results = await Promise.all(
        authenticators.map((authenticate) => authenticate(request)),
      );
      if (results.every((auth) => auth === null)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      const channel = url.searchParams.get("channel");
      const ts = url.searchParams.get("ts");
      if (channel === null || ts === null) return new Response(null, { status: 400 });
      const session = await resolveSession(`${channel}:${ts}`);
      return Response.json({ sessionId: session?.id ?? null });
    }),
  ],
};

export default channel;
