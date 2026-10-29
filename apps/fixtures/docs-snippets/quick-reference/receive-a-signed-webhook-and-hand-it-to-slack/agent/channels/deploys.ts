import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import slack from "./slack";

// Replace with your provider's scheme or SDK helper.
function isSigned(body: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.DEPLOYS_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default defineChannel({
  routes: [
    POST("/webhooks/deploys", async (request, ctx) => {
      const body = await request.text();
      const { headers } = request;
      if (!isSigned(body, headers.get("x-timestamp"), headers.get("x-signature"))) {
        return new Response("invalid signature", { status: 401 });
      }
      ctx.waitUntil(
        ctx.to(slack, { channelId: "C0123ABC" }).send(`Summarize this deploy event:\n${body}`, {
          auth: {
            authenticator: "deploys-webhook",
            principalType: "service",
            principalId: "deploys",
            attributes: {},
          },
        }),
      );
      return new Response("ok");
    }),
  ],
});
