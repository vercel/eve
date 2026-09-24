import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/reports", async (_request, { from }) => {
      const session = await from("reports").send("Prepare the reports.", {
        auth: null,
        taskDeliveryPolicy: "cohort",
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
