import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { instrumentationEntries } from "@vercel/eve-catalog";

interface RegistryFile {
  path: string;
  target?: string;
}

interface RegistryItem {
  name: string;
  files?: RegistryFile[];
}

interface Registry {
  items: RegistryItem[];
}

const registrySlugsByCatalogSlug: Readonly<Record<string, string>> = {
  braintrust: "braintrust",
  "sentry-instrumentation": "sentry",
  "datadog-instrumentation": "datadog",
  "honeycomb-instrumentation": "honeycomb",
  arize: "arize",
  raindrop: "raindrop",
  jaeger: "jaeger",
};

const docsRoot = join(import.meta.dirname, "..");
const registry = JSON.parse(await readFile(join(docsRoot, "registry.json"), "utf8")) as Registry;
const items = registry.items.filter((item) => item.name.startsWith("instrumentation/"));
const expectedSlugs = instrumentationEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map((entry) => registrySlugsByCatalogSlug[entry.slug]);
const actualSlugs = items.map((item) => item.name.slice("instrumentation/".length));

if (expectedSlugs.some((slug) => slug === undefined)) {
  throw new Error("Every gallery instrumentation provider needs a registry slug mapping.");
}
if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
  throw new Error(
    `Instrumentation registry entries do not match the gallery.\nExpected: ${expectedSlugs.join(", ")}\nActual: ${actualSlugs.join(", ")}`,
  );
}

for (const item of items) {
  const slug = item.name.slice("instrumentation/".length);
  const expectedPath = `registry/instrumentation/${slug}.ts`;
  const file = item.files?.[0];
  if (
    item.files?.length !== 1 ||
    file?.path !== expectedPath ||
    file.target !== "agent/instrumentation.ts"
  ) {
    throw new Error(
      `Registry item "${item.name}" must write ${expectedPath} to agent/instrumentation.ts.`,
    );
  }
  await access(join(docsRoot, expectedPath));
}
