import { recallChannel } from "eve/channels/recall";

import { recallWebhookUrl } from "../lib/webhook-url.js";

// Answers chat messages and speech that says "eve". Everything else is kept as
// recent transcript for the next turn, so "open a ticket for that" has context.
export default recallChannel({ webhookUrl: recallWebhookUrl() });
