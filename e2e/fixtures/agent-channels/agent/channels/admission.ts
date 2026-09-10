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
        action?: "reset";
      };
      if (body.sessionId === undefined) {
        const session = await ctx.from(body.address).open({ auth });
        return Response.json({ sessionId: session.id });
      }
      if (body.action === "reset")
        return Response.json(await ctx.attachSession(body.sessionId).reset());
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
