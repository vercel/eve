import { join } from "node:path";

import { text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { runVercel } from "#setup/primitives/run-vercel.js";
import { WizardCancelledError } from "#setup/step.js";

import type {
  IntegrationSetupContext,
  IntegrationSetupResult,
  SetupIntegration,
} from "../types.js";
import {
  createResendWebhook,
  deleteResendWebhook,
  listResendWebhooks,
  sameResendEndpoint,
  validateResendApiKey,
} from "./api.js";
import { provisionResendConnector } from "./connect.js";

export interface ResendSetupDeps {
  appendEnv: typeof appendEnv;
  createWebhook: typeof createResendWebhook;
  deleteWebhook: typeof deleteResendWebhook;
  deploy: typeof runDeployFlow;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureVercelProject: typeof ensureVercelProject;
  listWebhooks: typeof listResendWebhooks;
  provisionConnector: typeof provisionResendConnector;
  runVercel: typeof runVercel;
  validateApiKey: typeof validateResendApiKey;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: ResendSetupDeps = {
  appendEnv,
  createWebhook: createResendWebhook,
  deleteWebhook: deleteResendWebhook,
  deploy: runDeployFlow,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
  listWebhooks: listResendWebhooks,
  provisionConnector: provisionResendConnector,
  runVercel,
  validateApiKey: validateResendApiKey,
  writeTextFile,
};

function validateEmail(value: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : "Enter a complete email address.";
}

function channelTemplate(input: {
  apiKey: string;
  connectorUid?: string;
  fromAddress: string;
  fromName: string;
}): string {
  const apiKey = input.connectorUid
    ? `() => getToken(${JSON.stringify(input.connectorUid)}, { subject: { type: "app" } })`
    : `() => {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) throw new Error("RESEND_API_KEY is required.");
        return Promise.resolve(apiKey);
      }`;
  return `import { createMemoryState } from "@chat-adapter/state-memory";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
${input.connectorUid ? 'import { getToken } from "@vercel/connect";\n' : ""}import type { Message, Thread } from "chat";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: ${JSON.stringify(input.fromName || "Email Agent")},
  adapters: {
    resend: createResendAdapter({
      apiKey: ${apiKey},
      fromAddress: ${JSON.stringify(input.fromAddress)},
      fromName: ${JSON.stringify(input.fromName || "Email Agent")},
    }),
  },
  state: createMemoryState(),
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageToUserContent(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageToUserContent(message), { thread });
});

export default channel;
`;
}

async function chooseDestination(
  context: IntegrationSetupContext,
): Promise<"connect" | "portable"> {
  if (context.yes) return "connect";
  return context.ui.prompter.select<"connect" | "portable">({
    message: "How would you like to configure Resend?",
    options: [
      {
        value: "connect",
        label: "Set up Vercel Connect",
        hint: "Provision credentials, deploy, and configure the webhook",
      },
      {
        value: "portable",
        label: "Use portable credentials",
        hint: "Store the API key locally and configure the webhook manually",
      },
    ],
    initialValue: context.environment.vercel.kind === "available" ? "connect" : "portable",
  });
}

async function writeProductionSecret(
  context: IntegrationSetupContext,
  secret: string,
  deps: ResendSetupDeps,
): Promise<void> {
  const saved = await deps.runVercel(
    ["env", "add", "RESEND_WEBHOOK_SECRET", "production", "--force", "--yes"],
    {
      cwd: context.appRoot,
      nonInteractive: true,
      signal: context.signal,
      stdin: secret,
    },
  );
  if (!saved) throw new Error("Could not save RESEND_WEBHOOK_SECRET to Vercel production.");
}

/** Runs guided Resend credential, deployment, webhook, and channel setup. */
export async function setupResend(
  context: IntegrationSetupContext,
  deps: ResendSetupDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  try {
    const destination = await chooseDestination(context);
    if (destination === "connect" && context.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Resend setup.",
      );
    }
    const instructions = [
      "Use a full-access Resend API key. Setup needs webhook access, and the adapter fetches received-email contents.",
      "Create a key: https://resend.com/api-keys",
    ];
    if (context.ui.prompter.acknowledge) {
      await context.ui.prompter.acknowledge({ message: "Resend API key", lines: instructions });
    } else {
      context.ui.prompter.log.info(instructions.join("\n"));
    }
    const apiKey = (
      await context.ui.asker.ask(
        text({ key: "resend-api-key", message: "Resend API key", required: true, sensitive: true }),
      )
    ).trim();
    const fromAddress = (
      await context.ui.asker.ask(
        text({
          key: "resend-from-address",
          message: "From address",
          required: true,
          validate: validateEmail,
        }),
      )
    ).trim();
    const fromName = (
      await context.ui.asker.ask(
        text({ key: "resend-from-name", message: "From name (optional)", required: false }),
      )
    ).trim();
    await deps.validateApiKey(apiKey, context.signal);

    if (destination === "portable") {
      await deps.appendEnv(join(context.appRoot, ".env.local"), { RESEND_API_KEY: apiKey });
      await deps.appendEnv(join(context.appRoot, ".env.example"), {
        RESEND_API_KEY: "",
        RESEND_WEBHOOK_SECRET: "",
      });
      await deps.writeTextFile(
        join(context.appRoot, "agent/channels/resend.ts"),
        channelTemplate({ apiKey, fromAddress, fromName }),
        { force: context.force },
      );
      context.ui.nextSteps([
        "Deploy the agent and create a Resend webhook for https://<your-host>/eve/v1/resend subscribed only to email.received.",
        "Store its signing secret as RESEND_WEBHOOK_SECRET in your host's encrypted environment variables.",
      ]);
      return { kind: "done" };
    }

    const project = await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
    });
    const connector = await deps.provisionConnector({
      apiKey,
      log: context.ui.prompter.log,
      project,
      projectRoot: context.appRoot,
      slug: `resend-${await deps.deriveConnectorSlug(context.appRoot)}`,
      signal: context.signal,
    });
    try {
      await deps.writeTextFile(
        join(context.appRoot, "agent/channels/resend.ts"),
        channelTemplate({ apiKey, connectorUid: connector.uid, fromAddress, fromName }),
        { force: context.force },
      );
      const deployed = await deps.deploy({
        appRoot: context.appRoot,
        prompter: context.ui.prompter,
        interactive: true,
        signal: context.signal,
      });
      if (deployed.kind !== "deployed" || deployed.productionUrl === undefined) {
        throw new Error(
          `Connector ${connector.uid} is ready, but setup could not determine the production URL. Run \`vercel deploy --prod\`, then re-run Resend setup.`,
        );
      }
      const endpoint = new URL("/eve/v1/resend", deployed.productionUrl).href;
      const webhooks = await deps.listWebhooks(apiKey, context.signal);
      const exact = webhooks.filter((webhook) => sameResendEndpoint(webhook.endpoint, endpoint));
      let webhook = exact.find((candidate) => candidate.signing_secret !== undefined);
      let created = false;
      if (webhook === undefined) {
        webhook = await deps.createWebhook(apiKey, endpoint, context.signal);
        created = true;
      }
      try {
        await writeProductionSecret(context, webhook.signing_secret!, deps);
        const redeployed = await deps.deploy({
          appRoot: context.appRoot,
          prompter: context.ui.prompter,
          interactive: true,
          signal: context.signal,
        });
        if (redeployed.kind !== "deployed") throw new Error("Production redeploy was cancelled.");
      } catch (error) {
        if (created) await deps.deleteWebhook(apiKey, webhook.id, context.signal).catch(() => {});
        throw error;
      }
      if (created) {
        for (const previous of exact) {
          if (previous.id !== webhook.id) {
            await deps.deleteWebhook(apiKey, previous.id, context.signal).catch(() => {});
          }
        }
      }
      context.ui.nextSteps([
        `Resend endpoint: ${endpoint}`,
        `Send from ${fromAddress}; configure a receiving domain in Resend, then send an email and reply to smoke-test the thread.`,
      ]);
      return { kind: "done", facts: [{ label: "Resend webhook", value: endpoint, kind: "url" }] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason}\nResend connector ${connector.uid} may persist. Inspect it with \`vercel connect list\` and re-run \`eve add channel/resend\` to recover.`,
      );
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

/** Resend setup registration. */
export const RESEND_SETUP: SetupIntegration = {
  kind: "resend",
  label: "Resend",
  hint: "Threaded email through the Chat SDK",
  setup: setupResend,
};
