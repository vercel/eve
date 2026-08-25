import { defineChannel, POST } from "eve/channels";

interface MetadataProviderState {
  audience: "private" | "public" | "unknown";
  topic: string | null;
  contextMessages: string[];
  mutateAudienceOnTurn: boolean;
}

declare global {
  var __eveLiveChannelMetadata: unknown;
}

export default defineChannel({
  state: {
    audience: "unknown",
    topic: null,
    contextMessages: [],
    mutateAudienceOnTurn: false,
  } as MetadataProviderState,

  context(state) {
    return { state };
  },

  metadata(state) {
    return {
      audience: state.audience,
      topic: state.topic,
      contextMessages: state.contextMessages,
    };
  },

  routes: [
    POST<MetadataProviderState>("/metadata-provider/start", async (request, { from }) => {
      const body = (await request.json().catch(() => ({}))) as {
        message?: string;
        audience?: MetadataProviderState["audience"];
        topic?: string;
        contextMessages?: string[];
        mutateAudienceOnTurn?: boolean;
      };

      const session = await from(`mp:${crypto.randomUUID().slice(0, 8)}`).send(
        body.message ?? "hello",
        {
          auth: null,
          state: {
            audience: body.audience ?? "unknown",
            topic: body.topic ?? null,
            contextMessages: body.contextMessages ?? [],
            mutateAudienceOnTurn: body.mutateAudienceOnTurn === true,
          },
        },
      );

      return Response.json({ ok: true, sessionId: session.id });
    }),
  ],
  events: {
    "turn.started"(_event, channel) {
      if (channel.state.mutateAudienceOnTurn) channel.state.audience = "private";
      globalThis.__eveLiveChannelMetadata = {
        audience: channel.state.audience,
        contextMessages: channel.state.contextMessages,
        topic: channel.state.topic,
      };
    },
  },
});
