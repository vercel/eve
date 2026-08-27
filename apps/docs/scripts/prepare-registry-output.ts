import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Registry {
  items: { name: string }[];
}

// shadcn build writes public/r/<item name>.json but does not create nested
// output directories, so create them from the item names first.
const docsRoot = join(import.meta.dirname, "..");
const registryPath = join(docsRoot, "registry.json");
const registry = (await import(registryPath, { with: { type: "json" } })).default as Registry;

const outputDirs = new Set(
  registry.items.map((item) => dirname(join(docsRoot, "public/r", `${item.name}.json`))),
);
for (const dir of outputDirs) await mkdir(dir, { recursive: true });
