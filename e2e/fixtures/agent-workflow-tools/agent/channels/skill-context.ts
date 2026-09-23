import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

const requestBody = z.strictObject({
  threadId: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
  actor: z.enum(["alice", "bob"]),
});

export default defineChannel({
  state: { topic: "delegated-report", labels: ["context-contract"] },
  metadata: (state) => ({ topic: state.topic, labels: state.labels }),
  audience: () => "private",
  routes: [
    POST("/skill-context/send", async (request, { from }) => {
      const { threadId, message, actor } = requestBody.parse(await request.json());
      const session = await from(threadId).send(message, {
        auth: {
          principalId: actor === "alice" ? "workflow-e2e-user" : "workflow-e2e-reviewer",
          principalType: "user",
          authenticator: "e2e-fixture",
          issuer: "context-fixture",
          subject: actor,
          attributes: { actor, groups: ["reports", "reviewers"] },
        },
      });
      return Response.json({
        sessionId: session.id,
        environment:
          process.env.EVE_DEV === "1" || process.env.VERCEL_ENV === "development"
            ? "development"
            : process.env.VERCEL_ENV === "preview"
              ? "preview"
              : "production",
      });
    }),
  ],
});
