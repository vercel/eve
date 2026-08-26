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
  await deps.appendEnv(join(context.appRoot, ".env.local"), {
    SHOPIFY_STORE_DOMAIN: plan.storeDomain,
  });
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/ucp.ts"),
    SHOPIFY_UCP_CHANNEL_TEMPLATE,
    { force: context.force },
  );
  return { facts: [] };
}

export const SHOPIFY_SETUP = defineSetupIntegration({
  kind: "shopify",
  label: "Shopify",
  prepare: prepareShopifySetup,
  apply: applyShopifySetup,
});
