#!/usr/bin/env node
/**
 * CI lint that validates the `eve` import paths used in documentation code
 * samples against the package's real `exports` map.
 *
 * Docs are the most-copied surface of the framework, and the cheapest way for
 * a sample to rot is to import from a subpath that no longer exists (or never
 * did). Full type-checking of every snippet is noisy because many blocks are
 * intentional fragments; validating import specifiers against the exports map
 * is deterministic and catches the highest-frequency failure with no false
 * positives.
 *
 * Checks every ```ts / ```typescript fenced block under /docs: any
 * `from "eve..."` / `import("eve...")` specifier must resolve to a real
 * subpath in packages/eve/package.json#exports.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = `${repoRoot}/docs`;
const pkg = JSON.parse(readFileSync(`${repoRoot}/packages/eve/package.json`, "utf8"));

// Build the set of valid bare import specifiers from the exports map:
//   "."            -> "eve"
//   "./tools"      -> "eve/tools"
//   "./channels/x" -> "eve/channels/x"
const validSpecifiers = new Set();
for (const key of Object.keys(pkg.exports ?? {})) {
  if (key === "./package.json") continue;
  validSpecifiers.add(key === "." ? "eve" : `eve/${key.slice(2)}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

const fenceRe = /```(ts|tsx|typescript)\b[^\n]*\n([\s\S]*?)```/g;
// Capture the module specifier from static and dynamic imports/exports.
const specRe = /(?:from|import|export\s+\*\s+from)\s*\(?\s*["']([^"']+)["']/g;

const failures = [];
let blockCount = 0;
let specCount = 0;

for (const abs of walk(docsDir)) {
  const rel = relative(docsDir, abs);
  const source = readFileSync(abs, "utf8");
  let block;
  while ((block = fenceRe.exec(source)) !== null) {
    blockCount += 1;
    const code = block[2];
    let m;
    while ((m = specRe.exec(code)) !== null) {
      const spec = m[1];
      if (spec !== "eve" && !spec.startsWith("eve/")) continue; // only validate eve imports
      specCount += 1;
      if (!validSpecifiers.has(spec)) {
        failures.push({ file: rel, spec });
      }
    }
  }
}

if (failures.length === 0) {
  process.stdout.write(
    `[docs:snippets] ok — ${specCount} eve import path${specCount === 1 ? "" : "s"} across ${blockCount} code blocks resolve.\n`,
  );
  process.exit(0);
}

process.stderr.write("[docs:snippets] FAIL\n\n");
for (const { file, spec } of failures) {
  process.stderr.write(
    `  docs/${file}\n    → imports \`${spec}\`, which is not an exported subpath of \`eve\`\n\n`,
  );
}
process.stderr.write(
  `Valid \`eve\` subpaths come from packages/eve/package.json#exports. Fix the import or add the export.\n`,
);
process.exit(1);
