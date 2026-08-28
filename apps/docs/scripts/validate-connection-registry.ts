import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { connectionEntries } from "@eve/catalog";

interface RegistryFile {
  path: string;
  target?: string;
}

interface RegistryItem {
  name: string;
  dependencies?: string[];
  envVars?: Record<string, string>;
  files?: RegistryFile[];
  meta?: {
    eve?: {
      setup?:
        | {
            command?: string;
            package?: string;
            bin?: string;
            args?: string[];
          }
        | Array<{
            command?: string;
            package?: string;
            bin?: string;
            args?: string[];
          }>;
    };
  };
}

interface Registry {
  items: RegistryItem[];
}

const docsRoot = join(import.meta.dirname, "..");
const registry = JSON.parse(await readFile(join(docsRoot, "registry.json"), "utf8")) as Registry;
const items = registry.items.filter((item) => item.name.startsWith("connection/"));
const expectedSlugs = connectionEntries()
  .filter((entry) => entry.surfaces.registry)
  .map((entry) => entry.slug);
const actualSlugs = items.map((item) => item.name.slice("connection/".length));
const CONNECT_SERVICES: Readonly<Record<string, string>> = {
  agentcard: "mcp.agentcard.sh/mcp",
  vercel: "vercel",
  linear: "mcp.linear.app",
  notion: "mcp.notion.com",
  datadog: "mcp.datadoghq.com",
  honeycomb: "mcp.honeycomb.io",
  context: "mcp.context.dev",
  natural: "mcp.natural.com",
};
const CONNECT_CREATION_TYPES: Readonly<Record<string, string>> = {
  agentcard: "agentcard",
};
const CONNECT_METHODS: Readonly<Record<string, "mcp" | "oauth">> = {
  agentcard: "mcp",
};

if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
  throw new Error(
    `Connection registry entries do not match the catalog.\nExpected: ${expectedSlugs.join(", ")}\nActual: ${actualSlugs.join(", ")}`,
  );
}

for (const item of items) {
  const declaredSetup = item.meta?.eve?.setup;
  const setups =
    declaredSetup === undefined
      ? undefined
      : Array.isArray(declaredSetup)
        ? declaredSetup
        : [declaredSetup];
  if (
    setups?.some(
      (setup) =>
        setup.command === undefined ||
        setup.package === undefined ||
        setup.bin === undefined ||
        setup.args === undefined,
    )
  ) {
    throw new Error(
      `Registry item "${item.name}" setup entries must declare command, package, bin, and args.`,
    );
  }

  const slug = item.name.slice("connection/".length);
  if (slug !== "browser-use") {
    const creationType = CONNECT_CREATION_TYPES[slug];
    const connectionMethod = CONNECT_METHODS[slug];
    const expectedSetup =
      slug === "shopify"
        ? {
            command: "eve",
            package: "eve",
            bin: "eve",
            args: ["integration", "setup", "shopify"],
          }
        : {
            command: "eve",
            package: "eve",
            bin: "eve",
            args: [
              "integration",
              "connect",
              slug,
              CONNECT_SERVICES[slug] ?? slug,
              slug,
              ...(creationType === undefined ? [] : ["--creation-type", creationType]),
              ...(connectionMethod === undefined ? [] : ["--connection-method", connectionMethod]),
            ],
          };
    if (JSON.stringify(setups) !== JSON.stringify([expectedSetup])) {
      throw new Error(
        slug === "shopify"
          ? 'Registry item "connection/shopify" must run eve integration setup shopify.'
          : `Registry item "${item.name}" must configure its Vercel Connect connector through eve.`,
      );
    }
  }

  const expectedPath = `registry/connections/${slug}.ts`;
  const expectedTarget = `agent/connections/${slug}.ts`;
  const file = item.files?.[0];
  if (item.files?.length !== 1 || file?.path !== expectedPath || file.target !== expectedTarget) {
    throw new Error(
      `Registry item "${item.name}" must write ${expectedPath} to ${expectedTarget}.`,
    );
  }
  await access(join(docsRoot, expectedPath));

  switch (slug) {
    case "browser-use": {
      if (item.dependencies !== undefined || !("BROWSER_USE_API_KEY" in (item.envVars ?? {}))) {
        throw new Error(
          'Registry item "connection/browser-use" must declare its API key without Vercel Connect.',
        );
      }
      break;
    }
    case "shopify": {
      if (item.dependencies !== undefined) {
        throw new Error('Registry item "connection/shopify" must not declare dependencies.');
      }
      if (item.envVars !== undefined) {
        throw new Error(
          'Registry item "connection/shopify" must leave environment configuration to its guided setup.',
        );
      }
      break;
    }
    default: {
      if (!item.dependencies?.includes("@vercel/connect")) {
        throw new Error(`Registry item "${item.name}" must depend on @vercel/connect.`);
      }
    }
  }
}
