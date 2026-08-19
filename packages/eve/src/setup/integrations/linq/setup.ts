import { join } from "node:path";

import { select, text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { provisionLinqConnector } from "./connect.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

interface LinqSetupPlan {
  credentials: "connect" | "portable";
  connectorSlug?: string;
  project?: VercelProjectReference;
  apiKey?: string;
  signingSecret?: string;
}

const portableTemplate = `import { linqChannel } from "eve/channels/linq";

export default linqChannel({
  apiKey: process.env.LINQ_API_KEY!,
  signingSecret: process.env.LINQ_WEBHOOK_SECRET!,
});
`;

function connectTemplate(uid: string): string {
  return `import { connectLinqCredentials } from "@vercel/connect/eve";
import { linqChannel } from "eve/channels/linq";

export default linqChannel({
  ...connectLinqCredentials(${JSON.stringify(uid)}),
});
`;
}

export async function prepareLinqSetup(context: SetupPrepareContext): Promise<LinqSetupPlan> {
  const credentials = await context.asker.ask(
    select({
      key: "linq-credentials",
      message: "How would you like to configure Linq?",
      options: [
        {
          id: "connect",
          value: "connect" as const,
          label: "Set up Vercel Connect",
          hint: "Provision a managed Linq line",
        },
        {
          id: "portable",
          value: "portable" as const,
          label: "Use portable credentials",
          hint: "Register the webhook in Linq",
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
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Linq setup.",
      );
    }
    const project = await context.resolveVercelProject("Linq");
    const connectorSlug = await context.asker.ask(
      text({
        key: "linq-connector-name",
        message: "Name your Linq agent",
        recommended: await deriveSlackConnectorSlug(context.appRoot),
        required: true,
      }),
    );
    return { credentials, connectorSlug: connectorSlug.trim(), project };
  }
  const apiKey = await context.asker.ask(
    text({
      key: "linq-api-key",
      message: "Linq API key",
      required: true,
      sensitive: true,
      environment: "LINQ_API_KEY",
    }),
  );
  const signingSecret = await context.asker.ask(
    text({
      key: "linq-signing-secret",
      message: "Linq webhook signing secret",
      required: true,
      sensitive: true,
      environment: "LINQ_WEBHOOK_SECRET",
    }),
  );
  return { credentials, apiKey: apiKey.trim(), signingSecret: signingSecret.trim() };
}

export async function applyLinqSetup(plan: LinqSetupPlan, context: SetupApplyContext) {
  const path = join(context.appRoot, "agent/channels/linq.ts");
  let phoneNumber: string | undefined;
  if (plan.credentials === "connect") {
    const connector = await provisionLinqConnector({
      log: context.presenter.log,
      project: plan.project!,
      projectRoot: context.appRoot,
      slug: plan.connectorSlug!,
      signal: context.signal,
    });
    phoneNumber = connector.phoneNumber;
    await writeTextFile(path, connectTemplate(connector.uid), { force: context.force });
    if (phoneNumber !== undefined) {
      context.presenter.note(phoneNumber, "Text your agent", { tone: "success" });
    }
  } else {
    await appendEnv(join(context.appRoot, ".env.local"), {
      LINQ_API_KEY: plan.apiKey!,
      LINQ_WEBHOOK_SECRET: plan.signingSecret!,
    });
    await writeTextFile(path, portableTemplate, { force: context.force });
    context.presenter.nextSteps([
      "Deploy the agent, then create a Linq webhook subscription for https://<your-host>/eve/v1/linq with message.received, reaction.added, and reaction.removed events.",
    ]);
  }
  context.presenter.log.success("Scaffolded channel: linq");
  return {
    facts:
      phoneNumber === undefined
        ? []
        : [{ label: "Agent phone number", value: phoneNumber, kind: "phone" as const }],
    deploymentRequired: true as const,
  };
}

export const LINQ_SETUP = defineSetupIntegration({
  kind: "linq",
  label: "Linq",
  hint: "iMessage and SMS through Linq",
  prepare: prepareLinqSetup,
  apply: applyLinqSetup,
});
