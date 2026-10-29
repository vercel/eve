import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import slack from "./slack";

const MAX_AGE_SECONDS = 300;

function verify(body: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.ALERTS_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!(age <= MAX_AGE_SECONDS)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default defineChannel({
  routes: [
    POST("/webhooks/alerts", async (request, ctx) => {
      const body = await request.text();
      const { headers } = request;
      if (!verify(body, headers.get("x-timestamp"), headers.get("x-signature"))) {
        return new Response("invalid signature", { status: 401 });
      }
      const alert = JSON.parse(body) as { id: string };
      ctx.waitUntil(
        ctx.to(slack, { channelId: "C0ALERTS1" }).send(`New alert: ${JSON.stringify(alert)}`, {
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
