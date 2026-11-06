import { defineChannel, POST } from "eve/channels";

interface TeamChatState {
  channelId: string | null;
  messageTs: string | null;
}

/**
 * A stand-in for a Slack conversation: each post starts a session whose
 * metadata names the Slack channel and message, which the mounted
 * `slack-reactions` extension reads through its `scope` option.
 */
export default defineChannel({
  state: { channelId: null, messageTs: null } as TeamChatState,

  metadata(state) {
    return { channelId: state.channelId, messageTs: state.messageTs };
  },

  routes: [
    POST<TeamChatState>("/team-chat/message", async (request, { from }) => {
      const body = (await request.json()) as { channelId: string; messageTs: string; text: string };
      const delivery = await from(`team-chat:${crypto.randomUUID()}`).send(body.text, {
        auth: null,
        state: { channelId: body.channelId, messageTs: body.messageTs },
      });
      return Response.json({ ok: true, sessionId: delivery.sessionId });
    }),
  ],
});
