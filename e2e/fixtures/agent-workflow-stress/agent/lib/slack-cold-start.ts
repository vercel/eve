import { createHmac, timingSafeEqual } from "node:crypto";

// The Slack cold-start benchmark: an `app_mention` that starts a new thread,
// timed on the server from the webhook's arrival to the model call. Slack is
// a stub that answers every Web API method after a fixed delay, so the time
// is eve's, with Slack's latency held constant. On a hosted world the model
// may run on another instance than the webhook did; their clocks agree to
// within NTP sync.

/** Signs the eval's webhooks; the fixture checks them as Slack's signing secret would be. */
export const SLACK_SIGNING_SECRET = "agent-workflow-stress-slack-cold-start";
export const SLACK_TEAM_ID = "T0COLDSTART";
export const SLACK_BOT_USER_ID = "U0COLDBOT";
export const SLACK_PERSON_ID = "U0COLDUSER";

/**
 * Each stubbed Slack Web API call answers after this long: Slack's warm
 * latency from iad1 is about 10–20 ms. A free Slack would hide the cost of
 * the calls eve makes before the model, so it is never zero.
 */
export const SLACK_API_LATENCY_MS = 15;

/** The route the eval reads a thread's session from (the stub has no Slack to read it in). */
export const SLACK_SESSION_ROUTE = "/slack-cold-start/session";

const GUIDANCE_PATTERN = /slack-cold-start arrived=(\d+)/;

/** The mock model's reply: webhook arrival to the model call, on the server's clock. */
const REPLY_PATTERN = /^slack-cold-start model_call_ms=(\d+)$/;

// Arrival times by Slack message (`<channel>:<ts>`), from the webhook
// verifier to the message hook. Both run in the webhook's request, so they
// share this process.
const arrivals = new Map<string, number>();

/** Checks the signature as eve's default verifier would, and notes when the event arrived. */
export function verifySlackWebhook(request: Request, body: string): boolean {
  const arrivedAt = Date.now();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const expected = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return false;
  const event = (JSON.parse(body) as { event?: { channel?: unknown; ts?: unknown } }).event;
  if (typeof event?.channel === "string" && typeof event.ts === "string")
    arrivals.set(`${event.channel}:${event.ts}`, arrivedAt);
  return true;
}

/** Guidance carrying a message's arrival to the model, or undefined for one the verifier never saw. */
export function slackColdStartGuidance(message: {
  readonly channelId: string;
  readonly ts: string;
}): string | undefined {
  const key = `${message.channelId}:${message.ts}`;
  const arrivedAt = arrivals.get(key);
  if (arrivedAt === undefined) return undefined;
  arrivals.delete(key);
  return `slack-cold-start arrived=${arrivedAt}`;
}

/** The mock model's reply to a Slack cold-start message, or undefined for any other message. */
export function slackColdStartReply(message: string | null): string | undefined {
  const match = message === null ? null : GUIDANCE_PATTERN.exec(message);
  if (match === null) return undefined;
  return `slack-cold-start model_call_ms=${Date.now() - Number(match[1])}`;
}

/** Webhook arrival to the model call, from the mock model's reply. */
export function parseSlackColdStartReply(reply: string | undefined): number | undefined {
  const match = reply === undefined ? null : REPLY_PATTERN.exec(reply.trim());
  return match === null ? undefined : Number(match[1]);
}

let nextTs = 0;

/**
 * Stands in for Slack's Web API: every method answers `ok` after
 * {@link SLACK_API_LATENCY_MS}, with the fields eve reads. Channels are
 * public, and the author is a person.
 */
export async function slackApiStub(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
  const body = await readBody(request);
  await new Promise((resolve) => setTimeout(resolve, SLACK_API_LATENCY_MS));
  const channel = typeof body.channel === "string" ? body.channel : undefined;
  nextTs += 1;
  const ts = `${Math.floor(Date.now() / 1000)}.${String(nextTs % 1_000_000).padStart(6, "0")}`;
  const response: Record<string, unknown> = {
    ok: true,
    bot_id: "B0COLDBOT",
    team_id: SLACK_TEAM_ID,
    user_id: SLACK_BOT_USER_ID,
    channel,
    ts,
    message: { ts },
    messages: [],
    has_more: false,
  };
  if (method === "conversations.info")
    response.channel = {
      id: channel,
      name: "slack-cold-start",
      is_channel: true,
      is_private: false,
      is_im: false,
      is_mpim: false,
    };
  if (method === "users.info")
    response.user = {
      id: typeof body.user === "string" ? body.user : SLACK_PERSON_ID,
      name: "alice",
      real_name: "Alice",
      is_bot: false,
      profile: { display_name: "alice", real_name: "Alice", email: "alice@example.com" },
    };
  return Response.json(response);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (request.headers.get("content-type")?.includes("application/json"))
    return JSON.parse(text) as Record<string, unknown>;
  return Object.fromEntries(new URLSearchParams(text));
}
