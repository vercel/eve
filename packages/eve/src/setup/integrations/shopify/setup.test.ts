import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  applyShopifySetup,
  prepareShopifySetup,
  SHOPIFY_EXAMPLE_AGENT_PROFILE_URL,
} from "./setup.js";

vi.mock("#setup/append-env.js", () => ({
  appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
}));

import { appendEnv } from "#setup/append-env.js";

function contexts(answers: Record<string, unknown>) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
}

describe("Shopify setup", () => {
  it("requires the Shopify storefront domain", async () => {
    await expect(prepareShopifySetup(contexts({}).prepare)).rejects.toBeInstanceOf(
      InteractionRequired,
    );
  });

  it("strips the protocol and path from a storefront URL", async () => {
    const plan = await prepareShopifySetup(
      contexts({ "shopify.store-domain": "https://shop.example.com/products" }).prepare,
    );

    expect(plan.storeDomain).toBe("shop.example.com");
  });

  it("rejects an invalid storefront domain after normalization", async () => {
    await expect(
      prepareShopifySetup(contexts({ "shopify.store-domain": "https:///products" }).prepare),
    ).rejects.toThrow("Enter a valid Shopify storefront domain.");
  });

  it("uses Shopify's example UCP agent profile when the optional question is skipped", async () => {
    const context = contexts({ "shopify.store-domain": "shop.example.com" });
    const plan = await prepareShopifySetup(context.prepare);

    await applyShopifySetup(plan, context.apply);

    expect(appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      SHOPIFY_STORE_DOMAIN: "shop.example.com",
      UCP_AGENT_PROFILE_URL: SHOPIFY_EXAMPLE_AGENT_PROFILE_URL,
    });
  });

  it("rejects an agent profile URL that Shopify cannot fetch securely", async () => {
    await expect(
      prepareShopifySetup(
        contexts({
          "shopify.store-domain": "shop.example.com",
          "shopify.agent-profile-url": "http://agent.example.com/.well-known/ucp",
        }).prepare,
      ),
    ).rejects.toThrow("Agent profile URL must use HTTPS.");
  });

  it("writes a custom UCP agent profile URL to .env.local", async () => {
    const context = contexts({
      "shopify.store-domain": " shop.example.com ",
      "shopify.agent-profile-url": " https://agent.example.com/.well-known/ucp ",
    });
    const plan = await prepareShopifySetup(context.prepare);

    await applyShopifySetup(plan, context.apply);

    expect(appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      SHOPIFY_STORE_DOMAIN: "shop.example.com",
      UCP_AGENT_PROFILE_URL: "https://agent.example.com/.well-known/ucp",
    });
  });
});
