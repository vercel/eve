import { randomUUID } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { z } from "zod";
import { demoAuth } from "../lib/demo-auth";
import { demoIdentity } from "../lib/demo-identity";

const identity = demoIdentity(
  process.env.A2A_SIGNING_SECRET ?? "local-prototype-signing-key-do-not-deploy",
);
export default defineChannel({
  routes: [
    POST("/demo", async (request, { from }) => {
      const auth = await routeAuth(request, demoAuth);
      if (auth instanceof Response) return auth;
      const { message } = z.object({ message: z.string() }).parse(await request.json());
      const session = await from(randomUUID()).send(message, { auth });
      return Response.json({
        id: identity.issue(session.id, JSON.stringify([auth.authenticator, auth.principalId])),
      });
    }),
    GET("/demo/:id/events", async (request, { attachSession, params }) => {
      const auth = await routeAuth(request, demoAuth);
      if (auth instanceof Response) return auth;
      const session = attachSession(
        identity.read(params.id, JSON.stringify([auth.authenticator, auth.principalId])),
      );
      const tail = await session.getStreamTailIndex();
      const events = [];
      if (tail >= 0) {
        const reader = (await session.getEventStream()).getReader();
        try {
          for (let index = 0; index <= tail; index++) {
            const { done, value } = await reader.read();
            if (done) break;
            events.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return Response.json(events);
    }),
  ],
});
