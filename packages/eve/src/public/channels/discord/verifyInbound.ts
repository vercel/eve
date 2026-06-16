import { createLogger } from "#internal/logging.js";
import type { DiscordChannelCredentials } from "#public/channels/discord/discordChannel.js";
import { verifyDiscordRequest } from "#public/channels/discord/verify.js";

const log = createLogger("discord.channel");

/**
 * Verifies an inbound Discord request and returns its raw body, or
 * `null` when verification fails.
 */
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
