import { defineChannel, GET, DELETE } from "eve/channels";
import { clearCalls, readCalls } from "../../src/audit";

export default defineChannel({
  routes: [
    GET("/planning-audit", async (request) => {
      const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
      return Response.json(await readCalls(sessionId));
    }),
    DELETE("/planning-audit", async (request) => {
      const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
      await clearCalls(sessionId);
      return new Response(null, { status: 204 });
    }),
  ],
});
