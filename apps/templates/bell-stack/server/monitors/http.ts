import { timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "standardwebhooks";
import { ZodError } from "zod";
import { monitors, type MonitorService } from "./service";
import { readBounded } from "./provider";

export async function receiveWebhook(request: Request, service: () => MonitorService = monitors): Promise<Response> {
  if (!process.env.PARALLEL_WEBHOOK_SECRET?.trim()) return new Response("Unavailable", { status: 503 });
  if (Number(request.headers.get("content-length")) > 65_536) return new Response("Too large", { status: 413 });
  try {
    const body = await readBounded(new Response(request.body), 65_536);
    await service().ingest(body, Object.fromEntries(request.headers));
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response("Invalid signature", { status: 401 });
    if (error instanceof ZodError || error instanceof SyntaxError) return new Response("Invalid event", { status: 400 });
    return new Response("Unavailable", { status: 503 });
  }
}
export async function processMonitors(request: Request, service: () => MonitorService = monitors): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim(), supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return new Response("Unauthorized", { status: 401 });
  try { return Response.json(await service().process(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return new Response("Unavailable", { status: 503 }); }
}
