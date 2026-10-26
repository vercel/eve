import { z } from "#compiled/zod/index.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const DiscordApplicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  verify_key: z.string(),
});

/** Non-secret Discord application metadata resolved from a bot token. */
interface DiscordApplication {
  id: string;
  name: string;
  publicKey: string;
}

async function discordRequest(
  botToken: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(`${DISCORD_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

/** Validates a bot token and returns its Discord application. */
export async function resolveDiscordApplication(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordApplication> {
  const response = await discordRequest(
    botToken,
    "/oauth2/applications/@me",
    { method: "GET" },
    fetchImpl,
  );
  if (!response.ok) throw new Error(`Discord rejected the bot token (HTTP ${response.status}).`);
  const parsed = DiscordApplicationSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Discord returned incomplete application details.");
  return { id: parsed.data.id, name: parsed.data.name, publicKey: parsed.data.verify_key };
}

/** Registers the global command consumed by the default Discord channel. */
export async function registerDiscordCommand(
  applicationId: string,
  botToken: string,
  command: { name: string; description: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await discordRequest(
    botToken,
    `/applications/${encodeURIComponent(applicationId)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({
        name: command.name,
        description: command.description,
        type: 1,
        options: [
          {
            name: "message",
            description: "What should the agent do?",
            type: 3,
            required: true,
          },
          {
            name: "file",
            description: "A file for the agent to read",
            type: 11,
            required: false,
          },
        ],
      }),
    },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`Discord command registration failed (HTTP ${response.status}).`);
  }
}

/** Points Discord HTTP Interactions at a persisted Connect connector. */
export async function configureDiscordInteractionsEndpoint(
  botToken: string,
  connectorId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await discordRequest(
    botToken,
    "/applications/@me",
    {
      method: "PATCH",
      body: JSON.stringify({
        interactions_endpoint_url: `https://connect.vercel.com/trigger/${encodeURIComponent(connectorId)}`,
      }),
    },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`Discord rejected the interactions endpoint (HTTP ${response.status}).`);
  }
}

// Application flags: Message Content approved for a verified app, or self-served below 100 servers.
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
// The only flags an app may set itself: the limited presence, members, and message content intents.
const EDITABLE_INTENT_FLAGS = (1 << 13) | (1 << 15) | GATEWAY_MESSAGE_CONTENT_LIMITED;

const DiscordApplicationFlagsSchema = z.object({ flags: z.number().optional() });

/**
 * Turns on the Message Content intent, so messages that don't mention the bot,
 * such as thread follow-ups, arrive with their text. Returns `false` when
 * Discord refuses, as it does for a verified app in 100 or more servers, which
 * needs Discord's approval instead.
 */
export async function enableDiscordMessageContentIntent(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const current = await discordRequest(botToken, "/applications/@me", { method: "GET" }, fetchImpl);
  if (!current.ok) return false;
  const flags = DiscordApplicationFlagsSchema.safeParse(await current.json()).data?.flags ?? 0;
  if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0) return true;
  const response = await discordRequest(
    botToken,
    "/applications/@me",
    {
      method: "PATCH",
      body: JSON.stringify({
        flags: (flags & EDITABLE_INTENT_FLAGS) | GATEWAY_MESSAGE_CONTENT_LIMITED,
      }),
    },
    fetchImpl,
  );
  return response.ok;
}
