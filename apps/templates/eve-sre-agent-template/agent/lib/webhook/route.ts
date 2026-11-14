import type { RouteHandlerArgs } from "eve/channels";
import { readWebhookJson } from "#lib/webhook/request.ts";
import { parseInvestigationWebhook } from "./payload.ts";
import { type SlackChannelTarget, startInvestigation } from "./session.ts";

type InvestigationRouteArgs = Pick<RouteHandlerArgs, "to" | "waitUntil">;

export async function handleInvestigationWebhook(
  request: Request,
  args: InvestigationRouteArgs,
  slack: SlackChannelTarget
): Promise<Response> {
  const body = await readWebhookJson(request, process.env.WEBHOOK_SECRET);
  if (!body.ok) {
    return body.response;
  }

  const parsed = parseInvestigationWebhook(body.raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid request body", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  args.waitUntil(
    startInvestigation(parsed.data, args.to, slack).catch((error) => {
      console.error("[sre/investigation] webhook session start failed", {
        error,
      });
    })
  );

  return new Response(null, { status: 202 });
}
