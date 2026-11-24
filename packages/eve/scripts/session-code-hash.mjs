import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

const SESSION_WORKFLOW_ENTRIES = [
  "src/execution/session/entry.ts",
  "src/execution/legacy-session/turn-workflow.ts",
];
const IMPORT_RE =
  /\b(?:import|export)\s+(?!type\b)(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

export async function sessionCodeHash(packageRoot) {
  const reached = new Set();
  const queue = [...SESSION_WORKFLOW_ENTRIES];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    const source = await readFile(join(packageRoot, file), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      for (const target of resolveEveModule(match[1] ?? match[2], file)) {
        if (!reached.has(target) && existsSync(join(packageRoot, target))) queue.push(target);
      }
    }
  }
  const hash = createHash("sha256");
  for (const file of [...reached].sort()) {
    const source = await readFile(join(packageRoot, file), "utf8");
    hash.update(`${file}\0${source.replaceAll("\r\n", "\n")}\0`);
  }
  return hash.digest("hex").slice(0, 16);
}

function resolveEveModule(specifier, from) {
  const source = (path) => path.replace(/\.js$/, ".ts");
  if (specifier.startsWith("#compiled/")) return [];
  if (specifier.startsWith("#runtime-env/")) {
    const twin = source(`src/runtime-env/${specifier.slice("#runtime-env/".length)}`);
    return [twin, twin.replace(/\.ts$/, ".web.ts")];
  }
  if (specifier.startsWith("#")) return [source(`src/${specifier.slice(1)}`)];
  if (specifier.startsWith(".")) return [source(posix.join(posix.dirname(from), specifier))];
  return [];
}
