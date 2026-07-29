import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { connectionEntries } from "@vercel/eve-catalog";

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
      setup?: {
        command?: string;
        package?: string;
        bin?: string;
        args?: string[];
      };
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
  .filter((entry) => entry.surfaces.gallery)
  .map((entry) => entry.slug);
const actualSlugs = items.map((item) => item.name.slice("connection/".length));

if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
  throw new Error(
    `Connection registry entries do not match the gallery.\nExpected: ${expectedSlugs.join(", ")}\nActual: ${actualSlugs.join(", ")}`,
  );
}

for (const item of items) {
  const setup = item.meta?.eve?.setup;
  if (
    setup !== undefined &&
    (setup.command === undefined ||
      setup.package === undefined ||
      setup.bin === undefined ||
      setup.args === undefined)
  ) {
    throw new Error(
      `Registry item "${item.name}" setup must declare command, package, bin, and args during the migration.`,
    );
  }

  const slug = item.name.slice("connection/".length);
  const expectedPath = `registry/connections/${slug}.ts`;
  const expectedTarget = `agent/connections/${slug}.ts`;
  const file = item.files?.[0];
  if (item.files?.length !== 1 || file?.path !== expectedPath || file.target !== expectedTarget) {
    throw new Error(
      `Registry item "${item.name}" must write ${expectedPath} to ${expectedTarget}.`,
    );
  }
  await access(join(docsRoot, expectedPath));

  if (slug === "browser-use") {
    if (item.dependencies !== undefined || !("BROWSER_USE_API_KEY" in (item.envVars ?? {}))) {
      throw new Error(
        'Registry item "connection/browser-use" must declare its API key without Vercel Connect.',
      );
    }
  } else if (!item.dependencies?.includes("@vercel/connect")) {
    throw new Error(`Registry item "${item.name}" must depend on @vercel/connect.`);
  }
}
