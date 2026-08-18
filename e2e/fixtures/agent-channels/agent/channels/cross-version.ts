import { defineChannel, POST, type Session } from "eve/channels";

const smokeTestAuth = {
  attributes: { source: "smoke-test" },
  authenticator: "cross-version-webhook",
  principalId: "smoke-test",
  principalType: "service",
} as const;

type CrossVersionRouteContext = {
  readonly from?: (address: string) => {
    send(
      message: string,
      options: {
        readonly auth: typeof smokeTestAuth;
        readonly turnPolicy?: "queue" | "steer";
      },
    ): Promise<Session>;
  };
  readonly send?: (
    message: string,
    options: {
      readonly auth: typeof smokeTestAuth;
      readonly continuationToken: string;
    },
  ) => Promise<Session>;
};

export default defineChannel({
  routes: [
    POST("/cross-version-webhook", async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as {
        message?: string;
        sessionRef?: string;
        turnPolicy?: "queue" | "steer";
      };
      const message = body.message ?? "Reply with the single word: hello.";
      const address = body.sessionRef ?? crypto.randomUUID();
      const crossVersionContext = ctx as CrossVersionRouteContext;

      let session: Session;
      if (crossVersionContext.from !== undefined) {
        session = await crossVersionContext.from(address).send(message, {
          auth: smokeTestAuth,
          turnPolicy: body.turnPolicy,
        });
      } else if (crossVersionContext.send !== undefined) {
        session = await crossVersionContext.send(message, {
          auth: smokeTestAuth,
          continuationToken: address,
        });
      } else {
        throw new Error("Expected the route context to expose from() or send().");
      }

      return Response.json({ ok: true, sessionId: session.id });
    }),
  ],
});
