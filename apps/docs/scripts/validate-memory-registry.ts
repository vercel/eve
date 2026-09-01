import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { memoryEntries } from "@eve/catalog";

interface RegistryFile {
  path: string;
  target?: string;
}

interface RegistryItem {
  name: string;
  dependencies?: string[];
  envVars?: Record<string, string>;
  files?: RegistryFile[];
}

interface Registry {
  items: RegistryItem[];
}

const docsRoot = join(import.meta.dirname, "..");
const registry = JSON.parse(await readFile(join(docsRoot, "registry.json"), "utf8")) as Registry;
const items = registry.items.filter((item) => item.name.startsWith("memory/"));
const expectedSlugs = memoryEntries()
  .filter((entry) => entry.surfaces.registry)
  .map((entry) => entry.slug);
const actualSlugs = items.map((item) => item.name.slice("memory/".length));

if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
  throw new Error(
    `Memory registry entries do not match the catalog.\nExpected: ${expectedSlugs.join(", ")}\nActual: ${actualSlugs.join(", ")}`,
  );
}

for (const item of items) {
  const slug = item.name.slice("memory/".length);
  const expectedPath = `registry/memory/${slug}.ts`;
  const expectedTarget = `agent/memory/${slug}.ts`;
  const file = item.files?.[0];

  if (item.files?.length !== 1 || file?.path !== expectedPath || file.target !== expectedTarget) {
    throw new Error(
      `Registry item "${item.name}" must write ${expectedPath} to ${expectedTarget}.`,
    );
  }
  await access(join(docsRoot, expectedPath));

  if (slug === "supermemory") {
    if (!item.dependencies?.includes("@supermemory/eve")) {
      throw new Error('Registry item "memory/supermemory" must depend on @supermemory/eve.');
    }
    if (!("SUPERMEMORY_API_KEY" in (item.envVars ?? {}))) {
      throw new Error(
        'Registry item "memory/supermemory" must declare SUPERMEMORY_API_KEY as an environment variable.',
      );
    }
  }
}
