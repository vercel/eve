import { join } from "node:path";

import { text } from "#setup/ask.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { resolveIntegrationVercelProject } from "../shared/vercel-project.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  configureDiscordInteractionsEndpoint,
  registerDiscordCommand,
  resolveDiscordApplication,
} from "./api.js";
import { provisionDiscordConnector } from "./connect.js";

export interface DiscordSetupDeps {
  configureEndpoint: typeof configureDiscordInteractionsEndpoint;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  readProjectLink: typeof readProjectLink;
  provisionConnector: typeof provisionDiscordConnector;
  registerCommand: typeof registerDiscordCommand;
  resolveApplication: typeof resolveDiscordApplication;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: DiscordSetupDeps = {
  configureEndpoint: configureDiscordInteractionsEndpoint,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  readProjectLink,
  provisionConnector: provisionDiscordConnector,
  registerCommand: registerDiscordCommand,
  resolveApplication: resolveDiscordApplication,
  writeTextFile,
};

function validateCommandName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Command name is required.";
  if (name.length > 32) return "Command name must be 32 characters or fewer.";
  return /^[a-z0-9_-]+$/.test(name)
    ? null
    : "Use lowercase letters, numbers, hyphens, or underscores.";
}

function connectTemplate(uid: string): string {
  return `import { connectDiscordCredentials } from "@vercel/connect/eve";\nimport { discordChannel } from "eve/channels/discord";\n\nexport default discordChannel({\n  credentials: connectDiscordCredentials(${JSON.stringify(uid)}),\n});\n`;
}

export interface DiscordSetupPlan {
  botToken: string;
  commandName: string;
  commandDescription: string;
  project: VercelProjectReference;
  slug: string;
}

export async function prepareDiscordSetup(
  context: SetupPrepareContext,
  deps: DiscordSetupDeps = defaultDeps,
): Promise<DiscordSetupPlan> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Discord setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  context.presentation.log.info(
    "Create a Discord application or open an existing one, then go to Bot → Reset Token and copy the new bot token.\nCreate: https://discord.com/developers/applications?new_application=true\nExisting applications: https://discord.com/developers/applications",
  );
  const botToken = (
    await context.asker.ask(
      text({
        key: "discord-bot-token",
        message: "Discord bot token",
        required: true,
        sensitive: true,
        environment: "DISCORD_BOT_TOKEN",
      }),
    )
  ).trim();
  const commandName = await context.asker.ask(
    text({
      key: "discord-command-name",
      message: "Discord command name",
      detected: "ask",
      required: true,
      validate: validateCommandName,
    }),
  );
  const commandDescription = await context.asker.ask(
    text({
      key: "discord-command-description",
      message: "Discord command description",
      detected: "Ask the eve agent",
      required: true,
      validate: (value) =>
        value.trim().length === 0
          ? "Command description is required."
          : value.trim().length > 100
            ? "Command description must be 100 characters or fewer."
            : null,
    }),
  );
  const project = await resolveIntegrationVercelProject({
    appRoot: context.appRoot,
    integration: "Discord",
    signal: context.signal,
    deps,
  });
  return {
    botToken,
    commandName: commandName.trim(),
    commandDescription: commandDescription.trim(),
    project,
    slug: await deps.deriveConnectorSlug(context.appRoot),
  };
}

export async function applyDiscordSetup(
  plan: DiscordSetupPlan,
  context: SetupApplyContext,
  deps: DiscordSetupDeps = defaultDeps,
) {
  const application = await deps.resolveApplication(plan.botToken);
  const connector = await deps.provisionConnector({
    botToken: plan.botToken,
    log: context.presentation.log,
    project: plan.project,
    projectRoot: context.appRoot,
    slug: plan.slug,
    signal: context.signal,
  });
  await deps.registerCommand(application.id, plan.botToken, {
    name: plan.commandName,
    description: plan.commandDescription,
  });
  await deps.configureEndpoint(plan.botToken, connector.id);
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/discord.ts"),
    connectTemplate(connector.uid),
    { force: context.force },
  );
  const installUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(application.id)}&scope=${encodeURIComponent("bot applications.commands")}&permissions=3072`;
  context.presentation.nextSteps([
    `Install the Discord application, then try /${plan.commandName}: ${installUrl}`,
  ]);
  return {
    deploymentRequired: true as const,
    facts: [
      {
        label: "Discord application",
        value: `https://discord.com/developers/applications/${application.id}/information`,
        kind: "url" as const,
      },
    ],
  };
}

export const DISCORD_SETUP = defineSetupIntegration({
  kind: "discord",
  label: "Discord",
  hint: "Slash commands and interactions",
  prepare: prepareDiscordSetup,
  apply: applyDiscordSetup,
});
