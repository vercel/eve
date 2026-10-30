import { join, relative } from "node:path";

import { select, text } from "#setup/ask.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { WriteFileExistsError, writeTextFile } from "#setup/scaffold/files.js";

import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  configureDiscordInteractionsEndpoint,
  enableDiscordMessageContentIntent,
  registerDiscordCommand,
  resolveDiscordApplication,
} from "./api.js";
import { provisionDiscordConnector } from "./connect.js";
import {
  DISCORD_DAEMON_NAME,
  DISCORD_DAEMON_ROOT,
  discordDaemonEntry,
  discordDaemonFiles,
  readTextFile,
  withDiscordDaemon,
} from "./daemon.js";

export interface DiscordSetupDeps {
  configureEndpoint: typeof configureDiscordInteractionsEndpoint;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  enableMessageContent: typeof enableDiscordMessageContentIntent;
  provisionConnector: typeof provisionDiscordConnector;
  readTextFile: typeof readTextFile;
  registerCommand: typeof registerDiscordCommand;
  resolveApplication: typeof resolveDiscordApplication;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: DiscordSetupDeps = {
  configureEndpoint: configureDiscordInteractionsEndpoint,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  enableMessageContent: enableDiscordMessageContentIntent,
  provisionConnector: provisionDiscordConnector,
  readTextFile,
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

function connectTemplate(uid: string, gateway: boolean): string {
  return `import { connectDiscordCredentials } from "@vercel/connect/eve";
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
  credentials: connectDiscordCredentials(${JSON.stringify(uid)}),${gateway ? "\n  gateway: {}," : ""}
});
`;
}

/** View Channels and Send Messages, for slash command replies. */
const COMMAND_PERMISSIONS = "3072";
/** Also Read Message History, Create Public Threads, and Send Messages in Threads. */
const GATEWAY_PERMISSIONS = "309237713920";

interface DiscordSetupPlan {
  botToken: string;
  /** The slash command to register; absent when the agent answers messages instead. */
  command?: { readonly name: string; readonly description: string };
  /** How to register the Gateway relay; absent for slash commands only. */
  gateway?: DiscordGatewayPlan;
  project: VercelProjectReference;
  slug: string;
}

/** The project's Vercel config, checked before anything is written. */
type DiscordGatewayPlan =
  /** `vercel.json` with the daemon added, or `undefined` when it's already there. */
  | { readonly vercelJson: string | undefined }
  /** The project configures Vercel in `vercel.ts`, which setup doesn't edit. */
  | { readonly vercelTs: { readonly registered: boolean } };

export async function prepareDiscordSetup(
  context: SetupPrepareContext,
  deps: DiscordSetupDeps = defaultDeps,
): Promise<DiscordSetupPlan> {
  const messages = await context.asker.ask(
    select({
      key: "discord-messages",
      message: "How should people reach the agent in Discord?",
      options: [
        {
          id: "gateway",
          value: "gateway" as const,
          label: "DMs, mentions, and threads",
          hint: "Adds an experimental Discord Gateway relay that runs as a Vercel Daemon",
        },
        {
          id: "commands",
          value: "commands" as const,
          label: "A slash command",
          hint: "No long-running process",
        },
      ],
      // An experimental, always-on relay is a choice to make, not one for `--yes` to make silently.
      recommended: "commands" as const,
      required: true,
    }),
  );
  context.presenter.log.info(
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
  const command = messages === "commands" ? await askCommand(context) : undefined;
  // Checked before anything remote or on disk changes, so a conflict leaves nothing half-done.
  const gateway = await preflightFiles(context, messages === "gateway", deps);
  const project = await context.resolveVercelProject("Discord");
  const plan: DiscordSetupPlan = {
    botToken,
    project,
    slug: await deps.deriveConnectorSlug(context.appRoot),
  };
  if (command !== undefined) plan.command = command;
  if (gateway !== undefined) plan.gateway = gateway;
  return plan;
}

async function askCommand(
  context: SetupPrepareContext,
): Promise<{ readonly name: string; readonly description: string }> {
  const name = await context.asker.ask(
    text({
      key: "discord-command-name",
      message: "Discord command name",
      detected: "ask",
      required: true,
      validate: validateCommandName,
    }),
  );
  const description = await context.asker.ask(
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
  return { name: name.trim(), description: description.trim() };
}

/** Refuses files setup would overwrite without `--force`, and reads the project's Vercel config. */
async function preflightFiles(
  context: SetupPrepareContext,
  gateway: boolean,
  deps: DiscordSetupDeps,
): Promise<DiscordGatewayPlan | undefined> {
  const targets = [
    join(context.appRoot, "agent/channels/discord.ts"),
    ...(gateway
      ? Object.keys(discordDaemonFiles("")).map((path) =>
          join(context.projectRoot, DISCORD_DAEMON_ROOT, path),
        )
      : []),
  ];
  if (!context.force) {
    for (const path of targets) {
      if ((await deps.readTextFile(path)) !== undefined) throw new WriteFileExistsError(path);
    }
  }
  if (!gateway) return undefined;
  const vercelTs = await deps.readTextFile(join(context.projectRoot, "vercel.ts"));
  if (vercelTs !== undefined) {
    return { vercelTs: { registered: vercelTs.includes(DISCORD_DAEMON_NAME) } };
  }
  return {
    vercelJson: withDiscordDaemon(
      await deps.readTextFile(join(context.projectRoot, "vercel.json")),
    ),
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
    log: context.presenter.log,
    project: plan.project,
    projectRoot: context.projectRoot,
    slug: plan.slug,
    signal: context.signal,
  });
  if (plan.command !== undefined) {
    await deps.registerCommand(application.id, plan.botToken, plan.command);
  }
  // Button presses, including on sign-ins, arrive as interactions even without a command.
  await deps.configureEndpoint(plan.botToken, connector.id);
  const { gateway } = plan;
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/discord.ts"),
    connectTemplate(connector.uid, gateway !== undefined),
    { force: context.force },
  );
  const facts: { label: string; value: string; kind?: "url" }[] = [];
  if (gateway !== undefined) {
    // Without it, a thread's follow-ups arrive empty unless they mention the bot.
    const messageContent = await deps.enableMessageContent(plan.botToken).catch(() => false);
    if (!messageContent) {
      facts.push({
        label: "Enable Message Content",
        value: `Discord didn't let setup turn on Message Content Intent, so thread follow-ups must mention the bot. Turn it on under Bot in the Discord Developer Portal, then set messageContent: true in ${DISCORD_DAEMON_ROOT}/main.ts.`,
      });
    }
    for (const [path, content] of Object.entries(
      discordDaemonFiles(connector.uid, { messageContent }),
    )) {
      await deps.writeTextFile(join(context.projectRoot, DISCORD_DAEMON_ROOT, path), content, {
        force: context.force,
      });
    }
    if ("vercelJson" in gateway && gateway.vercelJson !== undefined) {
      await deps.writeTextFile(join(context.projectRoot, "vercel.json"), gateway.vercelJson, {
        force: true,
      });
    }
    if ("vercelTs" in gateway && !gateway.vercelTs.registered) {
      facts.push({
        label: `Add to the config ${relative(context.appRoot, join(context.projectRoot, "vercel.ts")) || "vercel.ts"} exports`,
        value: discordDaemonEntry(),
      });
    }
  }
  const installUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(application.id)}&scope=${encodeURIComponent("bot applications.commands")}&permissions=${gateway !== undefined ? GATEWAY_PERMISSIONS : COMMAND_PERMISSIONS}`;
  context.presenter.nextSteps([
    plan.command !== undefined
      ? `Install the bot from its install URL, then try /${plan.command.name}.`
      : "Install the bot from its install URL, then DM it or mention it in a channel.",
    ...(gateway !== undefined
      ? [
          `Deploy to start the experimental Gateway relay in ${DISCORD_DAEMON_ROOT}/. Run one instance per bot.`,
        ]
      : []),
  ]);
  return {
    deploymentRequired: true as const,
    // A fact, unlike a next step, stays visible after `/add` in `eve dev` collapses its panel.
    facts: [
      { label: "Discord bot install URL", value: installUrl, kind: "url" as const },
      {
        label: "Discord application dashboard",
        value: `https://discord.com/developers/applications/${application.id}/information`,
        kind: "url" as const,
      },
      ...facts,
    ],
  };
}

export const DISCORD_SETUP = defineSetupIntegration({
  kind: "discord",
  label: "Discord",
  hint: "Messages, DMs, and slash commands",
  prepare: prepareDiscordSetup,
  apply: applyDiscordSetup,
});
