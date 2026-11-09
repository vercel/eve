import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const docsRoot = join(import.meta.dirname, "..");
const registry = JSON.parse(await readFile(join(docsRoot, "registry.json"), "utf8")) as {
  items: { name: string; files?: { path: string; target?: string }[] }[];
};

for (const item of registry.items.filter((entry) => entry.name.startsWith("tool/"))) {
  const slug = item.name.slice("tool/".length);
  const entry = item.files?.find((file) => file.target === `agent/tools/${slug}.ts`);
  if (entry === undefined) throw new Error(`Registry tool "${slug}" has no authored tool module.`);
  // TypeScript's synthetic default imports can accept a re-export that the ESM linker rejects.
  const module = await import(pathToFileURL(join(docsRoot, entry.path)).href);
  if (module.default === undefined)
    throw new Error(`Registry tool "${slug}" has no default export.`);
}
