import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { select, text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { provisionTelegramConnector } from "./connect.js";
import { fetchTelegramBotUsername } from "./management.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface TelegramSetupDeps {
  fetchBotUsername: typeof fetchTelegramBotUsername;
}

const defaultDeps: TelegramSetupDeps = { fetchBotUsername: fetchTelegramBotUsername };

interface TelegramSetupPlan {
  credentials: "connect" | "portable";
  botToken: string;
  botUsername: string;
  connectorSlug?: string;
  project?: VercelProjectReference;
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
  if (credentials === "connect" && context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Telegram setup.",
    );
  }
  const project =
    credentials === "connect" ? await context.resolveVercelProject("Telegram") : undefined;
  const connectorSlug =
    credentials === "connect"
      ? await context.asker.ask(
          text({
            key: "telegram-connector-name",
            message: "Name your Telegram connector",
            recommended: await deriveSlackConnectorSlug(context.appRoot),
            required: true,
          }),
        )
      : undefined;
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
  const botUsername = await deps.fetchBotUsername(botToken, context.signal);
  const plan: TelegramSetupPlan = { credentials, botToken, botUsername };
  if (project !== undefined) plan.project = project;
  if (connectorSlug !== undefined) plan.connectorSlug = connectorSlug.trim();
  return plan;
}

async function applyTelegramSetup(plan: TelegramSetupPlan, context: SetupApplyContext) {
  const path = join(context.appRoot, "agent/channels/telegram.ts");
  if (plan.credentials === "connect") {
    const connector = await provisionTelegramConnector({
      botToken: plan.botToken,
      log: context.presenter.log,
      project: plan.project!,
      projectRoot: context.projectRoot,
      slug: plan.connectorSlug!,
      signal: context.signal,
    });
    await writeTextFile(path, connectTemplate(connector.uid, plan.botUsername), {
      force: context.force,
    });
  } else {
    const webhookSecretToken = randomBytes(32).toString("hex");
    await appendEnv(join(context.projectRoot, ".env.local"), {
      TELEGRAM_BOT_TOKEN: plan.botToken,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: webhookSecretToken,
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
