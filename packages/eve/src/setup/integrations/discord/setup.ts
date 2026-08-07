import { join } from "node:path";

import { text } from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { WizardCancelledError } from "#setup/step.js";

import type {
  IntegrationSetupContext,
  IntegrationSetupResult,
  SetupIntegration,
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
  ensureVercelProject: typeof ensureVercelProject;
  provisionConnector: typeof provisionDiscordConnector;
  registerCommand: typeof registerDiscordCommand;
  resolveApplication: typeof resolveDiscordApplication;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: DiscordSetupDeps = {
  configureEndpoint: configureDiscordInteractionsEndpoint,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
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
  return `import { connectDiscordCredentials } from "@vercel/connect/eve";
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
  credentials: connectDiscordCredentials(${JSON.stringify(uid)}),
});
`;
}

/** Runs guided Discord connector, command, and channel setup. */
export async function setupDiscord(
  context: IntegrationSetupContext,
  deps: DiscordSetupDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Discord setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  try {
    const applicationInstructions = [
      "Create a Discord application or open an existing one, then go to Bot → Reset Token and copy the new bot token.",
      "Create: https://discord.com/developers/applications?new_application=true",
      "Existing applications: https://discord.com/developers/applications",
    ];
    if (context.ui.prompter.acknowledge) {
      await context.ui.prompter.acknowledge({
        message: "Discord application",
        lines: applicationInstructions,
      });
    } else {
      context.ui.prompter.log.info(`Discord application\n${applicationInstructions.join("\n")}`);
    }
    const botToken = (
      await context.ui.asker.ask(
        text({
          key: "discord-bot-token",
          message: "Discord bot token",
          required: true,
          sensitive: true,
        }),
      )
    ).trim();
    const commandName = await context.ui.asker.ask(
      text({
        key: "discord-command-name",
        message: "Discord command name",
        detected: "ask",
        required: true,
        validate: validateCommandName,
      }),
    );
    const commandDescription = await context.ui.asker.ask(
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
    const application = await deps.resolveApplication(botToken);
    const project = await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
    });
    const connector = await deps.provisionConnector({
      botToken,
      log: context.ui.prompter.log,
      project,
      projectRoot: context.appRoot,
      slug: await deps.deriveConnectorSlug(context.appRoot),
      signal: context.signal,
    });
    await deps.registerCommand(application.id, botToken, {
      name: commandName.trim(),
      description: commandDescription.trim(),
    });
    // Connect configures this automatically when supported; the explicit call
    // makes setup deterministic while older API deployments are still live.
    await deps.configureEndpoint(botToken, connector.id);
    await deps.writeTextFile(
      join(context.appRoot, "agent/channels/discord.ts"),
      connectTemplate(connector.uid),
      { force: context.force },
    );
    const installUrl =
      `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(application.id)}` +
      `&scope=${encodeURIComponent("bot applications.commands")}&permissions=3072`;
    context.ui.nextSteps([
      `Install the Discord application, then try /${commandName.trim()}: ${installUrl}`,
    ]);
    return {
      kind: "done",
      completion: {
        deploymentRequired: true,
        facts: [
          {
            label: "Discord application",
            value: `https://discord.com/developers/applications/${application.id}/information`,
            kind: "url",
          },
        ],
      },
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

/** Discord setup registration. */
export const DISCORD_SETUP: SetupIntegration = {
  kind: "discord",
  label: "Discord",
  hint: "Slash commands and interactions",
  setup: setupDiscord,
};
