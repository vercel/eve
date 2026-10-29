import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import slack from "./slack";

// Replace with your provider's scheme or SDK helper.
function isSigned(body: string, signature: string | null): boolean {
  const secret = process.env.ALERTS_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default defineChannel({
  routes: [
    POST("/webhooks/alerts", async (request, ctx) => {
      const body = await request.text();
      if (!isSigned(body, request.headers.get("x-signature"))) {
        return new Response("invalid signature", { status: 401 });
      }
      ctx.waitUntil(
        ctx.to(slack, { channelId: "C0123ABC" }).send(`Triage this alert:\n${body}`, {
          auth: {
            authenticator: "alerts-webhook",
            principalType: "service",
            principalId: "alerts",
            attributes: {},
          },
        }),
      );
      return new Response("ok");
    }),
  ],
});
