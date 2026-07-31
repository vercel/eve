const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

/** Non-secret Discord application metadata resolved from a bot token. */
export interface DiscordApplication {
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
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("verify_key" in value) ||
    typeof value.verify_key !== "string"
  ) {
    throw new Error("Discord returned incomplete application details.");
  }
  return { id: value.id, name: value.name, publicKey: value.verify_key };
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
