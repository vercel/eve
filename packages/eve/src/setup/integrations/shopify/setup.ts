import { join } from "node:path";

import { appendEnv } from "#setup/append-env.js";
import { SkippedSignal, text } from "#setup/ask.js";

import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export const SHOPIFY_EXAMPLE_AGENT_PROFILE_URL =
  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json";

export interface ShopifySetupPlan {
  storeDomain: string;
  agentProfileUrl: string;
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

function validateProfileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? null : "Agent profile URL must use HTTPS.";
  } catch {
    return "Enter a valid HTTPS agent profile URL.";
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
  let agentProfileUrl = SHOPIFY_EXAMPLE_AGENT_PROFILE_URL;
  try {
    agentProfileUrl = await context.asker.ask(
      text({
        key: "shopify.agent-profile-url",
        message: "UCP agent profile URL (optional)",
        recommended: SHOPIFY_EXAMPLE_AGENT_PROFILE_URL,
        validate: validateProfileUrl,
      }),
    );
  } catch (error) {
    if (!(error instanceof SkippedSignal)) throw error;
  }

  return {
    storeDomain: normalizeStoreDomain(storeDomain),
    agentProfileUrl: agentProfileUrl.trim(),
  };
}

export async function applyShopifySetup(plan: ShopifySetupPlan, context: SetupApplyContext) {
  await appendEnv(join(context.appRoot, ".env.local"), {
    SHOPIFY_STORE_DOMAIN: plan.storeDomain,
    UCP_AGENT_PROFILE_URL: plan.agentProfileUrl,
  });
  return { facts: [] };
}

export const SHOPIFY_SETUP = defineSetupIntegration({
  kind: "shopify",
  label: "Shopify",
  prepare: prepareShopifySetup,
  apply: applyShopifySetup,
});
