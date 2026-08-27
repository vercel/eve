import { defineChannel, POST } from "eve/channels";

interface MetadataProviderState {
  topic: string | null;
  contextMessages: string[];
}

export default defineChannel({
  state: { topic: null, contextMessages: [] } as MetadataProviderState,

  metadata(state) {
    return {
      topic: state.topic,
      contextMessages: state.contextMessages,
    };
  },

  routes: [
    POST<MetadataProviderState>("/metadata-provider/start", async (request, { from }) => {
      const body = (await request.json().catch(() => ({}))) as {
        message?: string;
        topic?: string;
        contextMessages?: string[];
      };

      const session = await from(`mp:${crypto.randomUUID().slice(0, 8)}`).send(
        body.message ?? "hello",
        {
          auth: null,
          state: {
            topic: body.topic ?? null,
            contextMessages: body.contextMessages ?? [],
          },
        },
      );

      return Response.json({ ok: true, sessionId: session.id });
    }),
  ],
});
