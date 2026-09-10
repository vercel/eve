import { defineChannel, POST } from "eve/channels";

const auth = {
  attributes: {},
  authenticator: "admission-eval",
  principalId: "eval",
  principalType: "service",
} as const;

export default defineChannel({
  routes: [
    POST("/admission", async (request, ctx) => {
      const body = (await request.json()) as {
        address: string;
        sessionId?: string;
        operationId?: string;
        message?: string;
      };
      if (body.sessionId === undefined) {
        const session = await ctx.from(body.address).open({ auth });
        return Response.json({ sessionId: session.id });
      }
      const session = await ctx.resolveSession(body.address);
      if (session?.id !== body.sessionId)
        return new Response("Session does not own this address", { status: 409 });
      return Response.json(
        await ctx.attachSession(body.sessionId).send(body.message ?? "", {
          auth,
          operationId: body.operationId,
          turnPolicy: "queue",
        }),
      );
    }),
  ],
});
