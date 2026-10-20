const ROUTE = "/eve/v1/recall";

/**
 * Public URL Recall posts meeting events to. `RECALL_WEBHOOK_URL` wins, for
 * previews and tunnels to `eve dev`; otherwise the production deployment.
 */
export function recallWebhookUrl(): string | undefined {
  const explicit = process.env.RECALL_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) return undefined;
  const url = new URL(ROUTE, `https://${host}`);
  // Lets Recall past Deployment Protection when the project has a
  // Protection Bypass for Automation secret.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) url.searchParams.set("x-vercel-protection-bypass", bypass);
  return url.toString();
}
