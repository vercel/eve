import { defineChannel, POST } from "eve/channels";

/** The fixture eve channel's auth shape, with the scripted hitl model fixed. */
function authFor(request: Request) {
  const principalId = request.headers.get("x-eve-fixture-user") ?? "e2e-approval-responder";
  return {
    attributes: {
      fixture: "authorized-response",
      flag: request.headers.get("x-eve-fixture-flag") ?? "none",
      model: "hitl",
    },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

/** The message a shared-thread request carries. */
async function messageOf(request: Request): Promise<string> {
  const body = (await request.json().catch(() => ({}))) as { message?: string };
  return body.message ?? "";
}

/**
 * A shared thread: teammates address the same thread, so a message from
 * another person joins whatever turn is running instead of starting a new one.
 * The channel retains that turn's caller by default; the handover route lets
 * the sender adopt it. The server chooses the policy by route, not from the
 * request body.
 */
export default defineChannel({
  turnPolicy: { mode: "steer", principal: "retain" },
  routes: [
    POST("/shared/:threadId/messages", async (request, { from, params }) => {
      const session = await from(params.threadId ?? "").send(await messageOf(request), {
        auth: authFor(request),
      });
      return Response.json({ ok: true, sessionId: session.sessionId });
    }),
    POST("/shared/:threadId/handover", async (request, { from, params }) => {
      const session = await from(params.threadId ?? "").send(await messageOf(request), {
        auth: authFor(request),
        turnPolicy: { mode: "steer", principal: "adopt" },
      });
      return Response.json({ ok: true, sessionId: session.sessionId });
    }),
  ],
});
