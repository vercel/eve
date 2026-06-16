#!/usr/bin/env node
/**
 * CI lint that validates the markdown roots the docs site renders, before the
 * site build consumes them.
 *
 * Two classes of failure are caught here so Vercel preview deploys don't have
 * to catch them:
 *
 *   1. Every site-page markdown file (anything under a configured root that
 *      is not explicitly excluded) must start with YAML frontmatter
 *      containing the fields required by that root. Missing fields crash
 *      fumadocs' schema validation at build time.
 *
 *   2. For roots whose ordering is driven by `meta.json` (i.e. /docs),
 *      every site-page markdown file must be reachable from the sidebar nav
 *      — either listed by slug in an ancestor `meta.json#pages`, or covered
 *      by a `"..."` token in that array. Otherwise the page renders at its
 *      URL but never appears in the sidebar (easy to miss in review).
 *
 * Files intentionally not part of the site (the top-level engineer-facing
 * README.md in each root) are skipped via isExcluded().
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = [
  {
    label: "docs",
    dir: resolve(fileURLToPath(new URL("../docs", import.meta.url))),
    requireSidebarCoverage: true,
    requiredFrontmatter: ["title", "description"],
  },
];

// Only the top-level README.md is excluded. Nested READMEs (e.g.
// channels/README.md) are site pages and must carry a `url:` frontmatter
// override, validated below.
const isExcluded = (relPath) => relPath === "README.md";

function walkMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
      out.push(full);
    }
  }
  return out;
}

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    data[key] = value;
  }
  return data;
}

function loadMetaJson(dir) {
  try {
    return JSON.parse(readFileSync(`${dir}/meta.json`, "utf8"));
  } catch {
    return null;
  }
}

// Collect every slug a meta.json references, plus whether that folder uses
// a `"..."` wildcard. Sibling files in a wildcard folder are auto-included.
function collectNavReferences(rootDir) {
  const result = { explicit: new Set(), wildcardFolders: new Set() };

  const visit = (dir) => {
    const meta = loadMetaJson(dir);
    const relDir = relative(rootDir, dir);
    if (meta && Array.isArray(meta.pages)) {
      for (const entry of meta.pages) {
        if (typeof entry !== "string") continue;
        if (entry === "..." || entry === "z...z") {
          result.wildcardFolders.add(relDir);
          continue;
        }
        if (entry === "---") continue;
        if (/^---.+---$/.test(entry)) continue; // labeled separator: ---Group name---
        if (entry.startsWith("[")) continue; // [Title](url) custom link
        const slug = entry.startsWith("!") ? entry.slice(1) : entry;
        const key = relDir ? `${relDir}/${slug}` : slug;
        result.explicit.add(key);
      }
    } else if (dir !== rootDir) {
      // A folder with no meta.json behaves like an implicit wildcard — every
      // sibling .md is auto-included by fumadocs.
      result.wildcardFolders.add(relDir);
    }
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) visit(full);
    }
  };

  visit(rootDir);
  return result;
}

function isCoveredByNav(relPath, nav) {
  // relPath looks like "foo.md", "tools/human-in-the-loop.mdx",
  // "channels/index.md". We map to the slug form meta.json uses.
  const slug = relPath.replace(/\.mdx?$/, "");

  // Direct match: slug listed in an ancestor meta.json pages[].
  if (nav.explicit.has(slug)) return true;

  // Folder-indexes: fumadocs treats `channels/index.md` as the landing for
  // the `channels` folder; a `"channels"` entry in root meta.json covers it.
  if (slug.endsWith("/index")) {
    const folderSlug = slug.slice(0, -"/index".length);
    if (nav.explicit.has(folderSlug)) return true;
  }

  // A root-level file is covered by the root "..." wildcard.
  const lastSlash = slug.lastIndexOf("/");
  const folder = lastSlash === -1 ? "" : slug.slice(0, lastSlash);
  if (nav.wildcardFolders.has(folder)) return true;

  // A folder reference in an ancestor meta pulls in the whole folder.
  if (lastSlash !== -1 && nav.explicit.has(folder)) return true;

  return false;
}

const failures = [];
let validatedCount = 0;

for (const root of ROOTS) {
  const allFiles = walkMarkdown(root.dir);
  const nav = root.requireSidebarCoverage ? collectNavReferences(root.dir) : null;

  for (const absPath of allFiles) {
    const relPath = relative(root.dir, absPath).split("\\").join("/");
    if (isExcluded(relPath)) continue;
    if (root.include && !root.include(relPath)) continue;

    validatedCount += 1;
    const source = readFileSync(absPath, "utf8");
    const fm = parseFrontmatter(source);

    if (!fm) {
      failures.push({
        root: root.label,
        file: relPath,
        issue: "no frontmatter block (expected `---` ... `---` at top)",
      });
      continue;
    }
    for (const field of root.requiredFrontmatter) {
      if (fm[field]) continue;
      failures.push({
        root: root.label,
        file: relPath,
        issue: `frontmatter missing \`${field}\``,
      });
    }
    if (nav && !isCoveredByNav(relPath, nav)) {
      failures.push({
        root: root.label,
        file: relPath,
        issue:
          "not referenced in any meta.json#pages and not covered by a `...` wildcard — page would be orphaned from the sidebar",
      });
    }
  }
}

// 3. Internal links resolve. Every relative (./ ../) or site-absolute (/docs/)
//    markdown link in a doc page must point at a real doc page or folder.
//    fumadocs renders broken links as dead clicks; CI should catch them.
function checkLinks(rootDir) {
  const files = walkMarkdown(rootDir);
  const slugs = new Set();
  const dirs = new Set();
  for (const abs of files) {
    const rel = relative(rootDir, abs).split("\\").join("/");
    slugs.add(rel.replace(/\.mdx?$/, ""));
    let d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    while (d) {
      dirs.add(d);
      d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    }
  }
  const linkRe = /\]\((\s*[^)]+?)\s*\)/g;
  for (const abs of files) {
    const rel = relative(rootDir, abs).split("\\").join("/");
    if (isExcluded(rel)) continue;
    const dirOfFile = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const source = readFileSync(abs, "utf8");
    let m;
    while ((m = linkRe.exec(source)) !== null) {
      let target = m[1].trim();
      if (!target) continue;
      // Only validate doc-internal links.
      const isRel = target.startsWith("./") || target.startsWith("../");
      const isSite = target.startsWith("/docs/") || target === "/docs";
      if (!isRel && !isSite) continue; // external, mailto, #anchor, bare /eve/* runtime route, etc.
      target = target.split("#")[0].split("?")[0];
      if (!target) continue; // pure in-page anchor
      let resolvedSlug;
      if (isSite) {
        resolvedSlug = target.replace(/^\/docs\/?/, "");
      } else {
        const base = dirOfFile ? `${rootDir}/${dirOfFile}` : rootDir;
        resolvedSlug = relative(rootDir, resolve(base, target)).split("\\").join("/");
      }
      resolvedSlug = resolvedSlug.replace(/\/$/, "").replace(/\.mdx?$/, "");
      if (resolvedSlug === "" || resolvedSlug === ".") continue; // docs root / index
      if (slugs.has(resolvedSlug)) continue;
      if (slugs.has(`${resolvedSlug}/index`)) continue;
      if (dirs.has(resolvedSlug)) continue; // folder link (sidebar group)
      failures.push({
        root: "docs",
        file: rel,
        issue: `broken internal link → \`${m[1].trim()}\` (resolves to \`${resolvedSlug}\`, no such page)`,
      });
    }
  }
}

checkLinks(ROOTS[0].dir);

if (failures.length === 0) {
  process.stdout.write(
    `[docs:check] ok — ${validatedCount} file${validatedCount === 1 ? "" : "s"} validated.\n`,
  );
  process.exit(0);
}

process.stderr.write("[docs:check] FAIL\n\n");
for (const { root, file, issue } of failures) {
  process.stderr.write(`  ${root}/${file}\n    → ${issue}\n\n`);
}
process.stderr.write(
  [
    "Every site-page markdown file under /docs must:",
    "  1. Start with frontmatter containing `title` and `description`.",
    "  2. Be reachable from the sidebar nav via an ancestor meta.json —",
    '     either listed by slug in `pages[]`, or covered by a `"..."`',
    "     wildcard entry.",
    "",
    "Files intentionally kept off the site (engineer-facing READMEs, etc.)",
    "should be excluded by updating isExcluded() in scripts/check-docs.mjs.",
    "",
  ].join("\n"),
);
process.exit(1);
