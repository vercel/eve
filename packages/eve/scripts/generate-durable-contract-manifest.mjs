import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(import.meta.url), "../..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("eve package.json must declare a non-empty version.");
}

const { DURABLE_CONTRACT_MANIFEST_FILENAME, serializeDurableContractManifest } =
  await import("../dist/src/internal/durable-contract-registry.js");

await writeFile(
  resolve(packageRoot, "dist", DURABLE_CONTRACT_MANIFEST_FILENAME),
  serializeDurableContractManifest(packageJson.version),
);
