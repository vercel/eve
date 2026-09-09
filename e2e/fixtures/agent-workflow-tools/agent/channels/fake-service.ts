import { defineChannel, GET } from "eve/channels";

export default defineChannel({
  routes: [
    GET("/fixture-service/:service", async (request, { params }) => {
      if (
        params.service === "REJECTED" ||
        request.headers.get("authorization") !== "Bearer authorized-fixture-token"
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("WORKFLOW-STEP-AUTH:authorized");
    }),
  ],
});
