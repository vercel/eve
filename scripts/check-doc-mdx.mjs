#!/usr/bin/env node
/**
 * CI lint that compiles every docs page with the MDX compiler so syntax errors
 * are caught before the docs site build (turbopack + fumadocs-mdx) hits them.
 *
 * `check-docs.mjs` validates frontmatter, nav coverage, and links, but it does
 * not parse MDX, so a stray tag (e.g. a leaked `</...>`) or unbalanced JSX slips
 * through to the build. This compiles each `.md` / `.mdx` file the same way the
 * site does (markdown vs MDX by extension) and fails on the first parse error.
 *
 * `@mdx-js/mdx` is a transitive dependency (via fumadocs-mdx) and is not
 * importable by bare specifier from the repo root, so resolve it from the pnpm
 * store by globbing for the installed version.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = `${repoRoot}/docs`;

function findMdxPackage() {
  const store = `${repoRoot}/node_modules/.pnpm`;
  let match;
  try {
    match = readdirSync(store).find((d) => d.startsWith("@mdx-js+mdx@"));
  } catch {
    return null;
  }
  if (!match) return null;
  return `${store}/${match}/node_modules/@mdx-js/mdx/index.js`;
}

const mdxPath = findMdxPackage();
if (!mdxPath) {
  process.stderr.write(
    "[docs:mdx] could not resolve @mdx-js/mdx from the pnpm store; run `pnpm install`.\n",
  );
  process.exit(1);
}
const { compile } = await import(pathToFileURL(mdxPath).href);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

const files = walk(docsDir).filter((f) => relative(docsDir, f) !== "README.md");
const failures = [];
for (const abs of files) {
  const rel = relative(docsDir, abs);
  try {
    await compile(readFileSync(abs, "utf8"), { format: abs.endsWith(".mdx") ? "mdx" : "md" });
  } catch (err) {
    failures.push({ rel, message: String(err?.message ?? err).split("\n")[0] });
  }
}

if (failures.length === 0) {
  process.stdout.write(`[docs:mdx] ok — ${files.length} docs compile.\n`);
  process.exit(0);
}

process.stderr.write("[docs:mdx] FAIL\n\n");
for (const { rel, message } of failures) {
  process.stderr.write(`  docs/${rel}\n    → ${message}\n\n`);
}
process.exit(1);
