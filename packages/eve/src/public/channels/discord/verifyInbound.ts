import { createLogger } from "#internal/logging.js";
import type { DiscordChannelCredentials } from "#public/channels/discord/discordChannel.js";
import { verifyDiscordRequest } from "#public/channels/discord/verify.js";

const log = createLogger("discord.channel");

export async function verifyDiscordInbound(
  req: Request,
  credentials: DiscordChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifyDiscordRequest(req, {
      publicKey: credentials?.webhookVerifier ? undefined : credentials?.publicKey,
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("discord inbound verification failed", { error });
    return null;
  }
}
