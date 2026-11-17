import { z } from "#compiled/zod/index.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const DiscordApplicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  verify_key: z.string(),
});

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

const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const EDITABLE_INTENT_FLAGS = (1 << 13) | (1 << 15) | GATEWAY_MESSAGE_CONTENT_LIMITED;

const DiscordApplicationFlagsSchema = z.object({ flags: z.number().optional() });

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
