import { join } from "node:path";

import { text } from "#setup/ask.js";
import { appendEnv } from "#setup/append-env.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { runVercel } from "#setup/primitives/run-vercel.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

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
  suggestResendFromAddress,
  validateResendApiKey,
} from "./api.js";
import {
  authorizeResendMarketplaceSetup,
  createResendApiKey,
  deleteResendApiKey,
} from "./marketplace-oauth.js";
import {
  deleteMarketplaceResendWebhooks,
  reconcileMarketplaceResendWebhook,
} from "./marketplace-webhook.js";
import {
  connectResendMarketplaceResource,
  listResendMarketplaceResources,
  listVercelDomains,
  provisionResendMarketplaceResource,
  waitForResendMarketplaceDomain,
  type ResendMarketplaceResource,
} from "./marketplace.js";

export interface ResendSetupDeps {
  appendEnv: typeof appendEnv;
  createWebhook: typeof createResendWebhook;
  deleteWebhook: typeof deleteResendWebhook;
  deploy: typeof runDeployFlow;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureVercelProject: typeof ensureVercelProject;
  listWebhooks: typeof listResendWebhooks;
  listMarketplaceResources: typeof listResendMarketplaceResources;
  listDomains: typeof listVercelDomains;
  openUrl: typeof openUrl;
  provisionMarketplaceResource: typeof provisionResendMarketplaceResource;
  connectMarketplaceResource: typeof connectResendMarketplaceResource;
  authorizeMarketplaceSetup: typeof authorizeResendMarketplaceSetup;
  createApiKey: typeof createResendApiKey;
  deleteApiKey: typeof deleteResendApiKey;
  reconcileMarketplaceWebhook: typeof reconcileMarketplaceResendWebhook;
  deleteMarketplaceWebhooks: typeof deleteMarketplaceResendWebhooks;
  waitForMarketplaceDomain: typeof waitForResendMarketplaceDomain;
  runVercel: typeof runVercel;
  suggestFromAddress: typeof suggestResendFromAddress;
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
  listMarketplaceResources: listResendMarketplaceResources,
  listDomains: listVercelDomains,
  openUrl,
  provisionMarketplaceResource: provisionResendMarketplaceResource,
  connectMarketplaceResource: connectResendMarketplaceResource,
  authorizeMarketplaceSetup: authorizeResendMarketplaceSetup,
  createApiKey: createResendApiKey,
  deleteApiKey: deleteResendApiKey,
  reconcileMarketplaceWebhook: reconcileMarketplaceResendWebhook,
  deleteMarketplaceWebhooks: deleteMarketplaceResendWebhooks,
  waitForMarketplaceDomain: waitForResendMarketplaceDomain,
  runVercel,
  suggestFromAddress: suggestResendFromAddress,
  validateApiKey: validateResendApiKey,
  writeTextFile,
};

function validateEmail(value: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : "Enter a complete email address.";
}

function channelTemplate(input: { fromAddress: string; fromName: string }): string {
  return `import { createMemoryState } from "@chat-adapter/state-memory";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";
import { captureResendReplyContext, restoreResendReplyContext } from "eve/channels/resend";

export const { bot, channel, send } = chatSdkChannel({
  userName: ${JSON.stringify(input.fromName || "Eve")},
  adapters: {
    resend: createResendAdapter({
      apiKey: () => {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) throw new Error("RESEND_API_KEY is required.");
        return Promise.resolve(apiKey);
      },
      fromAddress: ${JSON.stringify(input.fromAddress)},
      fromName: ${JSON.stringify(input.fromName || "Eve")},
    }),
  },
  state: createMemoryState(),
  streaming: false,
  captureAdapterContext: captureResendReplyContext,
  restoreAdapterContext: restoreResendReplyContext,
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
): Promise<"marketplace" | "connect" | "portable"> {
  if (context.yes) return "marketplace";
  return context.ui.prompter.select<"marketplace" | "connect" | "portable">({
    message: "How would you like to configure Resend?",
    options: [
      {
        value: "marketplace",
        label: "Set up with a Vercel domain",
        hint: "Configure Resend, DNS, and project credentials for a domain in Vercel",
      },
      {
        value: "connect",
        label: "Use an existing Resend account",
        hint: "Sign in to create a dedicated credential for this agent",
      },
      {
        value: "portable",
        label: "Configure manually",
        hint: "Use environment variables and configure the webhook yourself",
      },
    ],
    initialValue: context.environment.vercel.kind === "available" ? "marketplace" : "portable",
  });
}

function marketplaceDomain(resource: ResendMarketplaceResource): string | undefined {
  const domain = (resource.metadata?.domain ?? resource.externalResourceId)?.trim().toLowerCase();
  if (domain === undefined) return undefined;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(domain) ? domain : undefined;
}

async function chooseMarketplaceResource(
  context: IntegrationSetupContext,
  resources: readonly ResendMarketplaceResource[],
): Promise<ResendMarketplaceResource | "create"> {
  if (resources.length === 0) return "create";
  if (resources.length === 1 || context.yes) return resources[0]!;
  const selected = await context.ui.prompter.select<string>({
    message: "Resend Marketplace resource",
    options: [
      ...resources.map((resource) => ({
        value: resource.id,
        label: marketplaceDomain(resource) ?? resource.name,
        hint: resource.status ?? "Existing Resend resource",
      })),
      { value: "create", label: "Configure another Vercel domain" },
    ],
    initialValue: resources[0]?.id,
  });
  return selected === "create"
    ? "create"
    : (resources.find((resource) => resource.id === selected) ?? "create");
}

const ADD_VERCEL_DOMAIN = "__add-vercel-domain__";

async function selectMarketplaceDomain(
  context: IntegrationSetupContext,
  deps: ResendSetupDeps,
  project: Awaited<ReturnType<typeof ensureVercelProject>>,
): Promise<string | "cancelled"> {
  const domains = await withSpinner(context.ui.prompter, "Checking Vercel domains...", () =>
    deps.listDomains({
      projectRoot: context.appRoot,
      project,
      signal: context.signal,
    }),
  );
  const openDomainSetup = (): "cancelled" => {
    const url = "https://vercel.com/domains";
    context.ui.prompter.note(
      `Add or purchase a domain in Vercel, then rerun \`eve add channel/resend\`.\n${url}`,
      "Vercel domain required",
      { tone: "warning" },
    );
    deps.openUrl(url);
    return "cancelled";
  };
  if (domains.length === 0) return openDomainSetup();
  if (context.yes) return domains[0]!;
  const selected = await context.ui.prompter.select<string>({
    message: "Domain for Resend",
    description: "Resend will open Vercel web to confirm account, billing, and DNS setup.",
    search: true,
    placeholder: "type to filter domains",
    options: [
      {
        value: ADD_VERCEL_DOMAIN,
        label: "Add or purchase a domain in Vercel",
        featured: true,
        trailingAction: true,
      },
      ...domains.map((domain, index) => ({
        value: domain,
        label: domain,
        featured: index < 4,
      })),
    ],
    initialValue: domains[0],
  });
  return selected === ADD_VERCEL_DOMAIN ? openDomainSetup() : selected;
}

async function setupMarketplace(
  context: IntegrationSetupContext,
  deps: ResendSetupDeps,
): Promise<IntegrationSetupResult> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Vercel Marketplace requires an authenticated Vercel CLI. Run `vercel login`, then retry Resend setup.",
    );
  }
  const project = await deps.ensureVercelProject({
    appRoot: context.appRoot,
    prompter: context.ui.prompter,
    signal: context.signal,
  });
  const resources = await withSpinner(
    context.ui.prompter,
    "Checking Resend Marketplace resources...",
    () =>
      deps.listMarketplaceResources({
        projectRoot: context.appRoot,
        project,
        signal: context.signal,
      }),
  );
  let resource = await chooseMarketplaceResource(context, resources);
  if (resource === "create") {
    const domain = await selectMarketplaceDomain(context, deps, project);
    if (domain === "cancelled") return { kind: "cancelled" };
    resource = await deps.provisionMarketplaceResource({
      domain,
      log: context.ui.prompter.log,
      projectRoot: context.appRoot,
      project,
      signal: context.signal,
    });
  }
  await deps.connectMarketplaceResource({
    resource,
    log: context.ui.prompter.log,
    projectRoot: context.appRoot,
    project,
    signal: context.signal,
  });
  const resourceDomain = marketplaceDomain(resource);
  if (resourceDomain !== undefined) {
    resource = await deps.waitForMarketplaceDomain({
      resource,
      domain: resourceDomain,
      log: context.ui.prompter.log,
      projectRoot: context.appRoot,
      project,
      signal: context.signal,
    });
  }
  const domain = marketplaceDomain(resource);
  const fromAddressQuestion =
    domain === undefined
      ? text({
          key: "resend-from-address",
          message: "Agent email address",
          required: true,
          validate: validateEmail,
        })
      : text({
          key: "resend-from-address",
          message: "Agent email address",
          detected: `eve@${domain}`,
          required: true,
          validate: validateEmail,
        });
  const fromAddress = await context.ui.asker.ask(fromAddressQuestion);
  const fromName = await context.ui.asker.ask(
    text({
      key: "resend-from-name",
      message: "From name (optional)",
      detected: "Eve",
      required: false,
    }),
  );
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/resend.ts"),
    channelTemplate({ fromAddress: fromAddress.trim(), fromName: fromName.trim() }),
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
      `Resend Marketplace resource ${resource.name} is ready, but setup could not determine the production URL. Run \`vercel deploy --prod\`, then rerun \`eve add channel/resend\`.`,
    );
  }
  const endpoint = new URL("/eve/v1/resend", deployed.productionUrl).href;
  const authorization = await deps.authorizeMarketplaceSetup({
    log: context.ui.prompter.log,
    projectRoot: context.appRoot,
    orgId: project.orgId,
    signal: context.signal,
  });
  const webhook = await deps.reconcileMarketplaceWebhook({
    accessToken: authorization.accessToken,
    endpoint,
    signal: context.signal,
  });
  try {
    await writeProductionSecret(context, webhook.signingSecret, deps);
    const redeployed = await deps.deploy({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      interactive: true,
      signal: context.signal,
    });
    if (redeployed.kind !== "deployed") throw new Error("Production redeploy was cancelled.");
  } catch (error) {
    await deps
      .deleteMarketplaceWebhooks({
        accessToken: authorization.accessToken,
        ids: [webhook.id],
        signal: context.signal,
      })
      .catch(() => {});
    await authorization.cleanup().catch(() => {});
    throw error;
  }
  await deps
    .deleteMarketplaceWebhooks({
      accessToken: authorization.accessToken,
      ids: webhook.previousIds.filter((id) => id !== webhook.id),
      signal: context.signal,
    })
    .catch(() => {});
  await authorization.cleanup();
  context.ui.nextSteps([
    `Resend endpoint: ${endpoint}`,
    `Send an email to ${fromAddress.trim()} and reply to smoke-test the conversation.`,
  ]);
  return {
    kind: "done",
    facts: [
      ...(domain === undefined ? [] : [{ label: "Resend domain", value: domain }]),
      { label: "Resend webhook", value: endpoint, kind: "url" as const },
    ],
  };
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
    if (destination === "marketplace") return await setupMarketplace(context, deps);
    if (destination === "connect" && context.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Using an existing Resend account requires an authenticated Vercel CLI. Run `vercel login`, then retry Resend setup.",
      );
    }
    let setupAuthorization: Awaited<ReturnType<typeof authorizeResendMarketplaceSetup>> | undefined;
    let createdApiKey: Awaited<ReturnType<typeof createResendApiKey>> | undefined;
    let apiKey: string;
    if (destination === "connect") {
      const project = await deps.ensureVercelProject({
        appRoot: context.appRoot,
        prompter: context.ui.prompter,
        signal: context.signal,
      });
      setupAuthorization = await deps.authorizeMarketplaceSetup({
        log: context.ui.prompter.log,
        projectRoot: context.appRoot,
        orgId: project.orgId,
        signal: context.signal,
      });
      createdApiKey = await deps.createApiKey({
        accessToken: setupAuthorization.accessToken,
        name: `eve · ${await deps.deriveConnectorSlug(context.appRoot)}`,
        signal: context.signal,
      });
      apiKey = createdApiKey.token;
    } else {
      const instructions = [
        "Use a full-access Resend API key. Setup needs webhook access, and the adapter fetches received-email contents.",
        "Create a key: https://resend.com/api-keys",
      ];
      if (context.ui.prompter.acknowledge) {
        await context.ui.prompter.acknowledge({ message: "Resend API key", lines: instructions });
      } else {
        context.ui.prompter.log.info(instructions.join("\n"));
      }
      apiKey = (
        await context.ui.asker.ask(
          text({
            key: "resend-api-key",
            message: "Resend API key",
            required: true,
            sensitive: true,
          }),
        )
      ).trim();
    }
    await deps.validateApiKey(apiKey, context.signal);
    const suggestedFromAddress = await deps.suggestFromAddress(apiKey, context.signal);
    const defaultFromAddress = suggestedFromAddress ?? "onboarding@resend.dev";
    if (suggestedFromAddress === undefined) {
      const senderInstructions = [
        "Resend's managed *.resend.app domain receives email but cannot send replies.",
        "For this test, onboarding@resend.dev is prefilled. It can send only to your Resend account email, may go to spam, and may not preserve normal reply behavior.",
        "For real conversations, add and verify a custom sending domain in Resend, then enter an address on that domain.",
        "Configure domains: https://resend.com/domains",
      ];
      context.ui.prompter.note(
        senderInstructions.join("\n"),
        "Warning: No custom Resend sending domain found",
        { tone: "warning" },
      );
    }
    const fromAddressQuestion = text({
      key: "resend-from-address",
      message: "Agent email address",
      detected: defaultFromAddress,
      required: true,
      validate: validateEmail,
    });
    const fromAddress = (await context.ui.asker.ask(fromAddressQuestion)).trim();
    const fromName = (
      await context.ui.asker.ask(
        text({
          key: "resend-from-name",
          message: "From name (optional)",
          detected: "Eve",
          required: false,
        }),
      )
    ).trim();

    if (destination === "portable") {
      await deps.appendEnv(join(context.appRoot, ".env.local"), { RESEND_API_KEY: apiKey });
      await deps.appendEnv(join(context.appRoot, ".env.example"), {
        RESEND_API_KEY: "",
        RESEND_WEBHOOK_SECRET: "",
      });
      await deps.writeTextFile(
        join(context.appRoot, "agent/channels/resend.ts"),
        channelTemplate({ fromAddress, fromName }),
        { force: context.force },
      );
      context.ui.nextSteps([
        "Deploy the agent and create a Resend webhook for https://<your-host>/eve/v1/resend subscribed only to email.received.",
        "Store its signing secret as RESEND_WEBHOOK_SECRET in your host's encrypted environment variables.",
      ]);
      return { kind: "done" };
    }

    await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
    });
    try {
      const savedApiKey = await deps.runVercel(
        ["env", "add", "RESEND_API_KEY", "production", "--force", "--yes"],
        {
          cwd: context.appRoot,
          nonInteractive: true,
          signal: context.signal,
          stdin: apiKey,
        },
      );
      if (!savedApiKey) throw new Error("Could not save RESEND_API_KEY to Vercel production.");
      await deps.writeTextFile(
        join(context.appRoot, "agent/channels/resend.ts"),
        channelTemplate({ fromAddress, fromName }),
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
          "The Resend credential is ready, but setup could not determine the production URL. Run `vercel deploy --prod`, then rerun Resend setup.",
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
      await setupAuthorization?.cleanup();
      context.ui.nextSteps([
        `Resend endpoint: ${endpoint}`,
        `Send from ${fromAddress}; configure a receiving domain in Resend, then send an email and reply to smoke-test the thread.`,
      ]);
      return { kind: "done", facts: [{ label: "Resend webhook", value: endpoint, kind: "url" }] };
    } catch (error) {
      if (createdApiKey !== undefined && setupAuthorization !== undefined) {
        await deps
          .deleteApiKey({
            accessToken: setupAuthorization.accessToken,
            id: createdApiKey.id,
            signal: context.signal,
          })
          .catch(() => {});
        await setupAuthorization.cleanup().catch(() => {});
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason}\nThe generated Resend API key may persist in the project's production environment. Rerun \`eve add channel/resend\` to recover.`,
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
