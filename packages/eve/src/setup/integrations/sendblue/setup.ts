import { basename, join } from "node:path";

import { select, text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import { provisionSendblueConnector } from "./connect.js";

interface PortableSendbluePlan {
  credentials: "environment";
  sendblue: { apiKey: string; apiSecret: string; fromNumber: string };
}

interface ConnectSendbluePlan {
  credentials: "vercel-connect";
  vercelProject: VercelProjectReference;
}

export type SendblueSetupPlan = PortableSendbluePlan | ConnectSendbluePlan;

export interface SendblueSetupDeps {
  appendEnv: typeof appendEnv;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  provisionConnector: typeof provisionSendblueConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: SendblueSetupDeps = {
  appendEnv,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  provisionConnector: provisionSendblueConnector,
  writeTextFile,
};

const PORTABLE_TEMPLATE = `import { sendblueChannel } from "eve/channels/sendblue";

export default sendblueChannel({
  async credentials() {
    const apiKey = process.env.SENDBLUE_API_KEY;
    const apiSecret = process.env.SENDBLUE_API_SECRET;
    if (!apiKey || !apiSecret) throw new Error("Sendblue API credentials are required.");
    return { apiKey, apiSecret };
  },
  fromNumber: process.env.SENDBLUE_FROM_NUMBER!,
  webhookSecret: process.env.SENDBLUE_WEBHOOK_SECRET,
});
`;

function connectTemplate(uid: string): string {
  return `import { connectSendblueCredentials } from "@vercel/connect/eve";
import { sendblueChannel } from "eve/channels/sendblue";

export default sendblueChannel({
  credentials: connectSendblueCredentials(${JSON.stringify(uid)}),
});
`;
}

export async function prepareSendblueSetup(
  context: SetupPrepareContext,
): Promise<SendblueSetupPlan> {
  const credentials = await context.asker.ask(
    select({
      key: "sendblue-credentials",
      message: "How would you like to configure Sendblue?",
      options: [
        {
          id: "vercel",
          value: "vercel-connect" as const,
          label: "Set up Vercel Connect",
          hint: "Create a managed Sendblue account and phone number",
        },
        {
          id: "portable",
          value: "environment" as const,
          label: "Use portable credentials",
          hint: "Configure Sendblue webhooks manually after deployment",
        },
      ],
      recommended:
        context.environment.vercel.kind === "available"
          ? ("vercel-connect" as const)
          : ("environment" as const),
      required: true,
    }),
  );
  if (credentials === "vercel-connect") {
    if (context.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Sendblue setup.",
      );
    }
    return { credentials, vercelProject: await context.resolveVercelProject("Sendblue") };
  }
  const apiKey = await context.asker.ask(
    text({
      key: "sendblue-api-key",
      message: "Sendblue API key",
      required: true,
      sensitive: true,
      environment: "SENDBLUE_API_KEY",
    }),
  );
  const apiSecret = await context.asker.ask(
    text({
      key: "sendblue-api-secret",
      message: "Sendblue API secret",
      required: true,
      sensitive: true,
      environment: "SENDBLUE_API_SECRET",
    }),
  );
  const fromNumber = await context.asker.ask(
    text({
      key: "sendblue-from-number",
      message: "Sendblue sending phone number",
      placeholder: "+15551234567",
      required: true,
    }),
  );
  return {
    credentials,
    sendblue: { apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), fromNumber: fromNumber.trim() },
  };
}

export async function applySendblueSetup(
  plan: SendblueSetupPlan,
  context: SetupApplyContext,
  deps: SendblueSetupDeps = defaultDeps,
) {
  const channelPath = join(context.appRoot, "agent/channels/sendblue.ts");
  if (plan.credentials === "vercel-connect") {
    const connector = await deps.provisionConnector({
      log: context.presenter.log,
      project: plan.vercelProject,
      projectRoot: context.appRoot,
      slug: await deps.deriveConnectorSlug(context.appRoot, basename(context.appRoot)),
      signal: context.signal,
    });
    await deps.writeTextFile(channelPath, connectTemplate(connector.uid), {
      force: context.force,
    });
  } else {
    await deps.appendEnv(join(context.appRoot, ".env.local"), {
      SENDBLUE_API_KEY: plan.sendblue.apiKey,
      SENDBLUE_API_SECRET: plan.sendblue.apiSecret,
      SENDBLUE_FROM_NUMBER: plan.sendblue.fromNumber,
    });
    await deps.writeTextFile(channelPath, PORTABLE_TEMPLATE, { force: context.force });
    context.presenter.nextSteps([
      "Deploy the agent, then create Sendblue webhooks pointing to https://<your-host>/eve/v1/sendblue.",
      "Set SENDBLUE_API_KEY, SENDBLUE_API_SECRET, SENDBLUE_FROM_NUMBER, and SENDBLUE_WEBHOOK_SECRET in your host's encrypted environment variables.",
    ]);
  }
  context.presenter.log.success("Scaffolded channel: sendblue");
  return { facts: [], deploymentRequired: true as const };
}

export const SENDBLUE_SETUP = defineSetupIntegration({
  kind: "sendblue",
  label: "Sendblue",
  hint: "Messages through Sendblue",
  prepare: prepareSendblueSetup,
  apply: applySendblueSetup,
});
