#!/usr/bin/env node
/**
 * CI lint that validates documentation's `eve` import paths against the export
 * map and imported names against the TypeScript module exports.
 *
 * Docs are the most-copied surface of the framework, and the cheapest way for
 * a sample to rot is to import from a subpath that no longer exists (or never
 * did). Full type-checking of every snippet is noisy because many blocks are
 * intentional fragments. Checking paths and names catches broken imports without
 * trying to typecheck the rest of a fragment.
 *
 * Checks every ```ts / ```typescript fenced block under /docs: any
 * `from "eve..."` / `import("eve...")` specifier must resolve to a real
 * subpath in packages/eve/package.json#exports; static imports must name exports
 * of that entry. Run eve's build first to materialize generated extension sources.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = `${repoRoot}/docs`;
const pkg = JSON.parse(readFileSync(`${repoRoot}/packages/eve/package.json`, "utf8"));
const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");
const entries = new Map();
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const declaration = typeof value === "object" ? value.types : value;
  if (typeof declaration !== "string" || !declaration.endsWith(".d.ts")) continue;
  const source = resolve(repoRoot, "packages/eve", declaration.replace(/^\.\/dist\//u, ""));
  const implementation = source.replace(/\.d\.ts$/u, ".ts");
  entries.set(
    key === "." ? "eve" : `eve/${key.slice(2)}`,
    existsSync(implementation) ? implementation : source,
  );
}
const program = ts.createProgram([...entries.values()], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  customConditions: ["eve-source"],
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const exportedNames = new Map();
for (const [entry, source] of entries) {
  const file = program.getSourceFile(source);
  if (file === undefined) throw new Error(`Build eve before checking docs: missing ${source}`);
  const symbol = checker.getSymbolAtLocation(file);
  exportedNames.set(
    entry,
    new Set(
      symbol === undefined ? [] : checker.getExportsOfModule(symbol).map((symbol) => symbol.name),
    ),
  );
}

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
    const parsed = ts.createSourceFile(
      "snippet.tsx",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const spec = statement.moduleSpecifier.text;
      const names = exportedNames.get(spec);
      if (names === undefined) continue;
      const clause = statement.importClause;
      const imported = [];
      if (clause?.name !== undefined) imported.push("default");
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        imported.push(
          ...clause.namedBindings.elements.map(
            (element) => (element.propertyName ?? element.name).text,
          ),
        );
      }
      for (const name of imported) {
        if (!names.has(name)) failures.push({ file: rel, spec, name });
      }
    }
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
    `[docs:snippets] ok — ${specCount} eve import path${specCount === 1 ? "" : "s"} across ${blockCount} code blocks resolve, with valid imported names.\n`,
  );
  process.exit(0);
}

process.stderr.write("[docs:snippets] FAIL\n\n");
for (const { file, spec, name } of failures) {
  process.stderr.write(
    name === undefined
      ? `  docs/${file}\n    → imports \`${spec}\`, which is not an exported subpath of \`eve\`\n\n`
      : `  docs/${file}\n    → \`${spec}\` does not export \`${name}\`\n\n`,
  );
}
process.stderr.write(
  `Valid \`eve\` subpaths come from packages/eve/package.json#exports. Fix the import or add the export.\n`,
);
process.exit(1);
