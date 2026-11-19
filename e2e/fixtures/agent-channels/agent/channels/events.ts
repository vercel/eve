import { defineChannel, POST } from "eve/channels";

/**
 * A channel that reports builds. A session subscribes to one of `events` for a project with the
 * `subscribe` tool; the `/events/emit` route stands in for the outside system that reports them.
 */
export default defineChannel({
  routes: [
    POST("/events/emit", async (request, { emit }) => {
      const body = (await request.json()) as { event: string; id: string; project: string };
      const delivered = await emit(
        body.event,
        { project: body.project },
        { id: body.id, data: { project: body.project } },
      );
      return Response.json({ delivered });
    }),
  ],
  subscriptions: {
    description:
      "Build events for a project: `build.finished` when a build succeeds and `build.failed` when it fails.",
    events: ["build.finished", "build.failed"],
    inputSchema: {
      additionalProperties: false,
      properties: { project: { description: "Project name in lowercase.", type: "string" } },
      required: ["project"],
      type: "object",
    },
    onEvent: ({ event }) =>
      `Build event ${event.name} ${event.id} for ${String(event.data.project)}.`,
  },
});
