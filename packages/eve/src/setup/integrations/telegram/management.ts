import { z } from "#compiled/zod/index.js";

const GetMeSchema = z.object({
  ok: z.literal(true),
  result: z.object({ is_bot: z.literal(true), username: z.string().min(1) }),
});

interface TelegramManagementDeps {
  fetch: typeof fetch;
}

const defaultDeps: TelegramManagementDeps = { fetch };

/** Validates a BotFather token with `getMe` and returns the bot's username. */
export async function fetchTelegramBotUsername(
  botToken: string,
  signal?: AbortSignal,
  deps: TelegramManagementDeps = defaultDeps,
): Promise<string> {
  const response = await deps.fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Telegram rejected the bot token (${response.status}). Copy the token from @BotFather and try again.`,
    );
  }
  const result = GetMeSchema.safeParse(await response.json());
  if (!result.success) throw new Error("Telegram returned invalid bot data.");
  return result.data.result.username;
}
