import { join } from "node:path";

import { select, text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { provisionLinqConnector, type LinqExistingAccountCredentials } from "./connect.js";
import { listLinqPhoneNumbers } from "./management.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface LinqSetupDeps {
  listPhoneNumbers: typeof listLinqPhoneNumbers;
}

const defaultDeps: LinqSetupDeps = { listPhoneNumbers: listLinqPhoneNumbers };

interface LinqSetupPlan {
  credentials: "connect" | "portable";
  connectorSlug?: string;
  existingAccount?: LinqExistingAccountCredentials;
  project?: VercelProjectReference;
  apiKey?: string;
  signingSecret?: string;
}

const portableTemplate = `import { linqChannel } from "eve/channels/linq";

export default linqChannel({
  credentials: {
    apiKey: process.env.LINQ_API_KEY!,
    signingSecret: process.env.LINQ_WEBHOOK_SECRET!,
  },
});
`;

function connectTemplate(uid: string): string {
  return `import { connectLinqCredentials } from "@vercel/connect/eve";
import { linqChannel } from "eve/channels/linq";

export default linqChannel({
  credentials: connectLinqCredentials(${JSON.stringify(uid)}),
});
`;
}

export async function prepareLinqSetup(
  context: SetupPrepareContext,
  deps: LinqSetupDeps = defaultDeps,
): Promise<LinqSetupPlan> {
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
    const account = await context.asker.ask(
      select({
        key: "linq-account",
        message: "Which Linq account would you like to use?",
        options: [
          {
            id: "new",
            value: "new" as const,
            label: "Create a new Linq account",
            hint: "Provision a new managed Linq line",
          },
          {
            id: "existing",
            value: "existing" as const,
            label: "Use an existing Linq account",
            hint: "Connect a Linq partner API token and select agent phone numbers",
          },
        ],
        recommended: "new" as const,
        required: true,
      }),
    );
    if (account === "new") return { credentials, connectorSlug: connectorSlug.trim(), project };
    const apiToken = await context.asker.ask(
      text({
        key: "linq-existing-api-token",
        message: "Linq partner API token",
        required: true,
        sensitive: true,
        environment: "LINQ_API_KEY",
      }),
    );
    const agentPhoneNumbers = await deps.listPhoneNumbers(apiToken.trim(), context.signal);
    const phoneNumbers = await context.asker.askMany({
      key: "linq-existing-phone-numbers",
      message: "Choose your agent's phone numbers",
      options: agentPhoneNumbers.map((phoneNumber) => ({
        id: phoneNumber,
        value: phoneNumber,
        label: phoneNumber,
      })),
      detected: agentPhoneNumbers,
      requireSelection: true,
      required: true,
    });
    return {
      credentials,
      connectorSlug: connectorSlug.trim(),
      existingAccount: {
        apiToken: apiToken.trim(),
        phoneNumbers,
      },
      project,
    };
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
    const connectorInput: Parameters<typeof provisionLinqConnector>[0] = {
      log: context.presenter.log,
      project: plan.project!,
      projectRoot: context.appRoot,
      slug: plan.connectorSlug!,
      signal: context.signal,
    };
    if (plan.existingAccount !== undefined) {
      connectorInput.existingAccount = plan.existingAccount;
    }
    const connector = await provisionLinqConnector(connectorInput);
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
