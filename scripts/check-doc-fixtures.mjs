#!/usr/bin/env node
/**
 * Keeps typechecked docs snippets identical to the copies shown on the page.
 *
 * Docs ship as raw Markdown in `node_modules/eve/docs`, where coding agents
 * read them directly, so pages hold literal copies instead of include
 * directives. `apps/fixtures/docs-snippets` holds the same code as real files
 * that `pnpm typecheck` compiles. A section's snippets live at
 * `<page path without extension>/<heading slug>/<block title>`, next to any
 * support files they import. A section that repeats another page's snippets
 * holds a `same-as.txt` naming that section's directory instead. This check fails when a page and its fixture
 * differ, when a fixture section no longer matches a heading, or when a
 * fully covered page gains a titled `ts` or `tsx` block without a fixture.
 *
 * The fixture is the source of truth: `--write` copies fixture files into the
 * pages.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = join(repoRoot, "docs");
const fixtureRoot = join(repoRoot, "apps/fixtures/docs-snippets");
const FULLY_COVERED = new Set(["quick-reference.md"]);
const SAME_AS = "same-as.txt";
const write = process.argv.includes("--write");

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");

function parseBlocks(source) {
  const blocks = [];
  const fence = /^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gmu;
  let section = "";
  let cursor = 0;
  let match;
  while ((match = fence.exec(source)) !== null) {
    for (const line of source.slice(cursor, match.index).split("\n")) {
      const heading = /^#{2,6} (.+)$/u.exec(line);
      if (heading) section = slug(heading[1]);
    }
    cursor = fence.lastIndex;
    const title = /\btitle="([^"]+)"/u.exec(match[2])?.[1];
    if (!["ts", "tsx"].includes(match[1]) || title === undefined) continue;
    const start = match.index + match[0].indexOf("\n") + 1;
    blocks.push({ section, title, code: match[3], start, end: start + match[3].length });
  }
  return blocks;
}

function listDirs(dir) {
  return readdirSync(dir).filter(
    (entry) => entry !== "node_modules" && statSync(join(dir, entry)).isDirectory(),
  );
}

function findSectionDirs(dir) {
  const docKey = relative(fixtureRoot, dir);
  const isPage = [".md", ".mdx"].some((ext) => existsSync(join(docsDir, docKey + ext)));
  return listDirs(dir).flatMap((entry) =>
    isPage ? [join(dir, entry)] : findSectionDirs(join(dir, entry)),
  );
}

const failures = [];
const expectedSections = new Set();
let checked = 0;

for (const page of readdirSync(docsDir, { recursive: true })) {
  if (!/\.mdx?$/u.test(page)) continue;
  const docKey = page.replace(/\.mdx?$/u, "");
  const fixtureDir = join(fixtureRoot, docKey);
  if (!existsSync(fixtureDir) && !FULLY_COVERED.has(page)) continue;
  const pagePath = join(docsDir, page);
  let source = readFileSync(pagePath, "utf8");
  const blocks = parseBlocks(source);
  const seen = new Set();
  const replacements = [];
  for (const block of blocks) {
    const sectionDir = join(fixtureDir, block.section);
    if (!existsSync(sectionDir)) {
      if (FULLY_COVERED.has(page)) {
        failures.push(`docs/${page} "${block.title}" under #${block.section} has no fixture`);
      }
      continue;
    }
    expectedSections.add(sectionDir);
    const key = `${block.section}/${block.title}`;
    if (seen.has(key)) {
      failures.push(`docs/${page} #${block.section} shows "${block.title}" twice; split it`);
      continue;
    }
    seen.add(key);
    checked += 1;
    const sameAs = join(sectionDir, SAME_AS);
    const sourceDir = existsSync(sameAs)
      ? join(fixtureRoot, readFileSync(sameAs, "utf8").trim())
      : sectionDir;
    const fixtureFile = join(sourceDir, block.title);
    const fixture = existsSync(fixtureFile) ? readFileSync(fixtureFile, "utf8") : null;
    if (fixture === block.code) continue;
    if (write && fixture !== null) replacements.push({ ...block, fixture });
    else failures.push(`docs/${page} #${key} differs from ${relative(repoRoot, fixtureFile)}`);
  }
  for (const { start, end, fixture } of replacements.reverse()) {
    source = source.slice(0, start) + fixture + source.slice(end);
  }
  if (replacements.length > 0) writeFileSync(pagePath, source);
}

for (const dir of findSectionDirs(fixtureRoot)) {
  if (!expectedSections.has(dir)) {
    failures.push(`${relative(repoRoot, dir)} matches no titled ts block in a docs heading`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`[docs:fixtures] FAIL\n\n${failures.map((f) => `  ${f}\n`).join("")}\n`);
  process.stderr.write(
    "Edit the fixture file, then run `node scripts/check-doc-fixtures.mjs --write` to copy it into the page.\n",
  );
  process.exit(1);
}
process.stdout.write(`[docs:fixtures] ok — ${checked} docs snippets match typechecked fixtures.\n`);
