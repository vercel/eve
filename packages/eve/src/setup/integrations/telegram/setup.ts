import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { confirm, select, text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { pathExists, WriteFileExistsError, writeTextFile } from "#setup/scaffold/files.js";

import { provisionTelegramConnector } from "./connect.js";
import { fetchTelegramBotUsername } from "./management.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface TelegramSetupDeps {
  fetchBotUsername: typeof fetchTelegramBotUsername;
  pathExists: typeof pathExists;
  readEnvFile: (path: string) => Promise<string | undefined>;
}

async function readEnvFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const defaultDeps: TelegramSetupDeps = {
  fetchBotUsername: fetchTelegramBotUsername,
  pathExists,
  readEnvFile,
};

const CHANNEL_FILE = "agent/channels/telegram.ts";

type TelegramSetupPlan =
  | {
      credentials: "connect";
      botToken: string;
      botUsername: string;
      connectorSlug: string;
      project: VercelProjectReference;
    }
  | {
      credentials: "portable";
      botToken: string;
      botUsername: string;
      /** Overwrite a different `TELEGRAM_BOT_TOKEN` already in `.env.local`. */
      replaceBotToken: boolean;
    };

/** Reads one unquoted or double-quoted value from dotenv text. */
function envValue(contents: string | undefined, key: string): string | undefined {
  for (const line of contents?.split("\n") ?? []) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    const raw = trimmed.slice(key.length + 1);
    return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return undefined;
}

function portableTemplate(botUsername: string): string {
  return `import { telegramChannel } from "eve/channels/telegram";

export default telegramChannel({
  botUsername: ${JSON.stringify(botUsername)},
  credentials: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
  },
});
`;
}

function connectTemplate(uid: string, botUsername: string): string {
  return `import { connectTelegramCredentials } from "@vercel/connect/eve";
import { telegramChannel } from "eve/channels/telegram";

export default telegramChannel({
  botUsername: ${JSON.stringify(botUsername)},
  credentials: connectTelegramCredentials(${JSON.stringify(uid)}),
});
`;
}

export async function prepareTelegramSetup(
  context: SetupPrepareContext,
  deps: TelegramSetupDeps = defaultDeps,
): Promise<TelegramSetupPlan> {
  // Refuse an overwrite before setup creates a connector or edits `.env.local`.
  const channelPath = join(context.appRoot, CHANNEL_FILE);
  if (!context.force && (await deps.pathExists(channelPath))) {
    throw new WriteFileExistsError(channelPath);
  }
  const credentials = await context.asker.ask(
    select({
      key: "telegram-credentials",
      message: "How would you like to configure Telegram?",
      options: [
        {
          id: "connect",
          value: "connect" as const,
          label: "Set up Vercel Connect",
          hint: "Connect stores the token and registers the webhook",
        },
        {
          id: "portable",
          value: "portable" as const,
          label: "Use portable credentials",
          hint: "Register the webhook with Telegram yourself",
        },
      ],
      recommended:
        context.environment.vercel.kind === "available"
          ? ("connect" as const)
          : ("portable" as const),
      required: true,
    }),
  );
  if (credentials === "connect") {
    if (context.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Telegram setup.",
      );
    }
    const project = await context.resolveVercelProject("Telegram");
    const connectorSlug = await context.asker.ask(
      text({
        key: "telegram-connector-name",
        message: "Name your Telegram connector",
        recommended: await deriveSlackConnectorSlug(context.appRoot),
        required: true,
      }),
    );
    const bot = await askBotToken(context, deps);
    return { credentials, ...bot, connectorSlug: connectorSlug.trim(), project };
  }

  const bot = await askBotToken(context, deps);
  const existingToken = envValue(
    await deps.readEnvFile(join(context.projectRoot, ".env.local")),
    "TELEGRAM_BOT_TOKEN",
  );
  const replaceBotToken = existingToken !== undefined && existingToken !== bot.botToken;
  if (replaceBotToken && !context.force) {
    const replace = await context.asker.ask(
      confirm({
        key: "telegram-replace-bot-token",
        message: `.env.local already has a different TELEGRAM_BOT_TOKEN. Replace it with @${bot.botUsername}'s token?`,
        recommended: false,
        required: true,
      }),
    );
    if (!replace) {
      throw new Error(
        "Telegram setup stopped: .env.local keeps its existing TELEGRAM_BOT_TOKEN, which belongs to a different bot. Remove it or rerun setup with that bot's token.",
      );
    }
  }
  return { credentials, ...bot, replaceBotToken };
}

async function askBotToken(
  context: SetupPrepareContext,
  deps: TelegramSetupDeps,
): Promise<{ botToken: string; botUsername: string }> {
  const botToken = (
    await context.asker.ask(
      text({
        key: "telegram-bot-token",
        message: "Telegram bot token from @BotFather",
        required: true,
        sensitive: true,
        environment: "TELEGRAM_BOT_TOKEN",
      }),
    )
  ).trim();
  return { botToken, botUsername: await deps.fetchBotUsername(botToken, context.signal) };
}

async function applyTelegramSetup(plan: TelegramSetupPlan, context: SetupApplyContext) {
  const path = join(context.appRoot, CHANNEL_FILE);
  if (plan.credentials === "connect") {
    const connector = await provisionTelegramConnector({
      botToken: plan.botToken,
      log: context.presenter.log,
      project: plan.project,
      projectRoot: context.projectRoot,
      slug: plan.connectorSlug,
      signal: context.signal,
    });
    await writeTextFile(path, connectTemplate(connector.uid, plan.botUsername), {
      force: context.force,
    });
  } else {
    const envPath = join(context.projectRoot, ".env.local");
    await appendEnv(
      envPath,
      { TELEGRAM_BOT_TOKEN: plan.botToken },
      { force: plan.replaceBotToken },
    );
    // An existing secret still matches whatever webhook was registered with it.
    await appendEnv(envPath, {
      TELEGRAM_WEBHOOK_SECRET_TOKEN: randomBytes(32).toString("hex"),
    });
    await writeTextFile(path, portableTemplate(plan.botUsername), { force: context.force });
    context.presenter.nextSteps([
      "Deploy the agent with TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN from .env.local, then call Telegram's setWebhook with https://<your-host>/eve/v1/telegram and that secret_token.",
    ]);
  }
  context.presenter.log.success("Scaffolded channel: telegram");
  return {
    facts: [
      { label: "Telegram bot", value: `https://t.me/${plan.botUsername}`, kind: "url" as const },
    ],
    deploymentRequired: true as const,
  };
}

export const TELEGRAM_SETUP = defineSetupIntegration({
  kind: "telegram",
  label: "Telegram",
  hint: "Telegram bot for 1:1 and group chats",
  prepare: prepareTelegramSetup,
  apply: applyTelegramSetup,
});
