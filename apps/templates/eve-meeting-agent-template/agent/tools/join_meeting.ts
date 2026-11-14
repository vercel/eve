import { defineTool } from "eve/tools";
import { z } from "zod";

import { createBot, RECALL_AUTHENTICATOR } from "../lib/recall.js";

export default defineTool({
  description:
    "Send the meeting bot to a Zoom, Google Meet, or Microsoft Teams meeting. The host may need to admit it.",
  inputSchema: z.object({
    meetingUrl: z.url({ protocol: /^https$/ }).describe("The meeting's join link."),
  }),
  async execute({ meetingUrl }, ctx) {
    // Keep people in one meeting from sending the bot to others.
    if (ctx.session.auth.initiator?.authenticator === RECALL_AUTHENTICATOR) {
      throw new Error("Join other meetings from outside a meeting.");
    }
    const bot = await createBot({ meetingUrl, webhookUrl: webhookUrl() });
    return { botId: bot.id, status: "joining" };
  },
});

function webhookUrl(): string {
  const explicit = process.env.RECALL_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (host) {
    // Recall requires a trailing slash before a query string.
    const url = new URL(`https://${host}/recall/webhook/`);
    // Lets Recall past Deployment Protection when the project has a
    // Protection Bypass for Automation secret.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) url.searchParams.set("x-vercel-protection-bypass", bypass);
    return url.toString();
  }
  throw new Error(
    "Set RECALL_WEBHOOK_URL to a public HTTPS URL for /recall/webhook, such as a tunnel to `eve dev`.",
  );
}
