import { defineChannel, POST } from "eve/channels";

/**
 * A channel that reports builds. A session subscribes to `build.finished` or `build.failed` for a
 * project with the `eve__subscribe` tool; the `/events/emit` route stands in for the outside system that
 * reports them. A project that starts with `denied-` may not be subscribed to.
 */
export default defineChannel({
  routes: [
    POST("/events/emit", async (request, { experimental }) => {
      const body = (await request.json()) as { event: string; id: string; project: string };
      const delivered = await experimental.subscriptions.emit(
        body.event,
        { project: body.project },
        { id: body.id, data: { project: body.project } },
      );
      return Response.json({ delivered });
    }),
  ],
  experimental: {
    subscriptions: {
      events: ["build.finished", "build.failed"].map((name) => ({
        name,
        description: `A build of a project ${name === "build.failed" ? "failed" : "finished"}.`,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["project"],
          properties: {
            project: { type: "string", description: "The project name in lowercase." },
          },
        },
      })),
      onSubscribe: ({ subscription }) => {
        if (String(subscription.input.project).startsWith("denied-"))
          throw new Error(`Project ${String(subscription.input.project)} may not be watched.`);
      },
      onEvent: ({ event }) =>
        `Build event ${event.name} ${event.id} for ${String(event.data.project)}.`,
    },
  },
});
