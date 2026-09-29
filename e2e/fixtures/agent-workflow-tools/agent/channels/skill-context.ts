import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

const actorSchema = z.enum(["alice", "bob"]);

const requestBody = z.strictObject({
  threadId: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
  actor: actorSchema,
});

const respondBody = z.strictObject({
  threadId: z.string().min(1).max(100),
  requestId: z.string().min(1).max(200),
  optionId: z.string().min(1).max(100),
  actor: actorSchema,
});

function actorAuth(actor: z.infer<typeof actorSchema>) {
  return {
    principalId: actor === "alice" ? "workflow-e2e-user" : "workflow-e2e-reviewer",
    principalType: "user",
    authenticator: "e2e-fixture",
    issuer: "context-fixture",
    subject: actor,
    attributes: { actor, groups: ["reports", "reviewers"] },
  };
}

export default defineChannel({
  state: { topic: "delegated-report", labels: ["context-contract"] },
  metadata: (state) => ({ topic: state.topic, labels: state.labels }),
  audience: () => "private",
  routes: [
    POST("/skill-context/send", async (request, { from }) => {
      const { threadId, message, actor } = requestBody.parse(await request.json());
      const session = await from(threadId).send(message, { auth: actorAuth(actor) });
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
    POST("/skill-context/respond", async (request, { from }) => {
      const { threadId, requestId, optionId, actor } = respondBody.parse(await request.json());
      const session = await from(threadId).respond([{ optionId, requestId }], {
        auth: actorAuth(actor),
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
