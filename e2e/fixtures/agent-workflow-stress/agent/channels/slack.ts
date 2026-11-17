import { GET } from "eve/channels";
import { localDev, vercelOidc } from "eve/channels/auth";
import {
  defaultSlackAuth,
  slackChannel,
  slackContinuationToken,
  type SlackChannel,
} from "eve/channels/slack";

import {
  SLACK_SESSION_ROUTE,
  slackApiStub,
  slackNewThreadGuidance,
  verifySlackWebhook,
} from "../lib/slack-new-thread";

// eve's Slack channel against a stubbed Slack, for the Slack new-thread eval
// (lib/slack-new-thread.ts). The message hook is eve's default plus guidance
// that carries the webhook's arrival time to the model.
const slack = slackChannel({
  api: { fetch: slackApiStub },
  credentials: { botToken: "xoxb-slack-new-thread", webhookVerifier: verifySlackWebhook },
  onAppMention: (ctx, message) => ({
    auth: defaultSlackAuth(message, ctx),
    guidance: slackNewThreadGuidance(message),
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
      const channelId = url.searchParams.get("channel");
      const threadTs = url.searchParams.get("ts");
      if (channelId === null || threadTs === null) return new Response(null, { status: 400 });
      const session = await resolveSession(slackContinuationToken({ channelId, threadTs }));
      return Response.json({ sessionId: session?.id ?? null });
    }),
  ],
};

export default channel;
