import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyShopifySetup, prepareShopifySetup, type ShopifySetupDeps } from "./setup.js";

function contexts(answers: Record<string, unknown>) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
}

function deps(): ShopifySetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    writeTextFile: vi.fn(async () => {}),
  };
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

  it("writes the storefront environment and a UCP channel containing the anonymous profile", async () => {
    const effects = deps();
    const context = contexts({ "shopify.store-domain": " shop.example.com " });
    const plan = await prepareShopifySetup(context.prepare);

    await expect(applyShopifySetup(plan, context.apply, effects)).resolves.toEqual({ facts: [] });

    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      SHOPIFY_STORE_DOMAIN: "shop.example.com",
    });
    expect(effects.writeTextFile).toHaveBeenCalledOnce();
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/ucp.ts",
      expect.stringContaining('"dev.ucp.shopping.cart"'),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/ucp.ts",
      expect.stringContaining('GET("/.well-known/ucp"'),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/ucp.ts",
      expect.stringContaining('"cache-control": "public, max-age=300"'),
      { force: undefined },
    );
  });

  it("does not advertise order support for anonymous traffic", async () => {
    const effects = deps();
    const context = contexts({ "shopify.store-domain": "shop.example.com" });

    await applyShopifySetup(await prepareShopifySetup(context.prepare), context.apply, effects);

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/ucp.ts",
      expect.not.stringContaining("dev.ucp.shopping.order"),
      { force: undefined },
    );
  });
});
