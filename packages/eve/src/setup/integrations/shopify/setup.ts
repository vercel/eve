import { join } from "node:path";

import { appendEnv } from "#setup/append-env.js";
import { text } from "#setup/ask.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import { SHOPIFY_UCP_CHANNEL_TEMPLATE } from "./templates.js";

export interface ShopifySetupDeps {
  appendEnv: typeof appendEnv;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: ShopifySetupDeps = { appendEnv, writeTextFile };

export interface ShopifySetupPlan {
  storeDomain: string;
}

function normalizeStoreDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "");
}

function validateStoreDomain(value: string): string | null {
  const domain = normalizeStoreDomain(value);
  try {
    const url = new URL(`https://${domain}`);
    return domain.length > 0 &&
      url.hostname.includes(".") &&
      !url.username &&
      !url.password &&
      !url.port
      ? null
      : "Enter a valid Shopify storefront domain.";
  } catch {
    return "Enter a valid Shopify storefront domain.";
  }
}

export async function prepareShopifySetup(context: SetupPrepareContext): Promise<ShopifySetupPlan> {
  const storeDomain = await context.asker.ask(
    text({
      key: "shopify.store-domain",
      message: "Shopify storefront domain",
      placeholder: "your-store.myshopify.com",
      required: true,
      validate: validateStoreDomain,
    }),
  );
  return { storeDomain: normalizeStoreDomain(storeDomain) };
}

export async function applyShopifySetup(
  plan: ShopifySetupPlan,
  context: SetupApplyContext,
  deps: ShopifySetupDeps = defaultDeps,
) {
  context.presenter.log.message("Scaffolding Shopify UCP channel and storefront environment...");
  await deps.appendEnv(join(context.appRoot, ".env.local"), {
    SHOPIFY_STORE_DOMAIN: plan.storeDomain,
  });
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/ucp.ts"),
    SHOPIFY_UCP_CHANNEL_TEMPLATE,
    { force: context.force },
  );
  context.presenter.log.success("Scaffolded channel: ucp");
  context.presenter.nextSteps([
    `Set SHOPIFY_STORE_DOMAIN in .env.local.`,
    "Shopify cannot reach localhost, so `eve dev` uses Shopify's example agent profile automatically. To test your own profile locally, expose the /.well-known/ucp route with a tool like ngrok.",
  ]);
  return {
    deploymentRequired: true as const,
    facts: [{ label: "Store domain", value: plan.storeDomain, kind: "text" as const }],
  };
}

export const SHOPIFY_SETUP = defineSetupIntegration({
  kind: "shopify",
  label: "Shopify",
  prepare: prepareShopifySetup,
  apply: applyShopifySetup,
});
