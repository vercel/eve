/**
 * Framework-shipped endpoint behind `createWebhook()` in authored workflow
 * bodies.
 *
 * `createWebhook()` mints `<deployment>/.well-known/workflow/v1/webhook/<token>`,
 * the Workflow SDK's conventional path, so external systems a tool hands the
 * URL to can call back without knowing anything about eve. The handler resumes
 * the hook with the request itself; the SDK serializes it so the body reads a
 * `Request` and owns the response semantics.
 */

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { resumeWebhook } from "#internal/workflow/runtime.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { walkCauseChain } from "#shared/errors.js";

export const WORKFLOW_WEBHOOK_ROUTE_PATTERN = "/.well-known/workflow/v1/webhook/:token";

export async function handleWorkflowWebhookRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing webhook token.", ok: false }, { status: 400 });
  }

  try {
    return await resumeWebhook(token, request);
  } catch (error) {
    for (const candidate of walkCauseChain(error)) {
      if (HookNotFoundError.is(candidate)) {
        return Response.json({ error: "Webhook not pending.", ok: false }, { status: 404 });
      }
    }
    throw error;
  }
}
