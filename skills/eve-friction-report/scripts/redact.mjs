#!/usr/bin/env node
// Anonymization for gap-register reports.
//
//   node redact.mjs <report.md> --map <dir> [--project <root>]          rewrite in place with placeholders
//   node redact.mjs <report.md> --map <dir> [--project <root>] --check  list anything identifying still present
//
// <dir>/anonymize.json:
// {
//   "org":    ["acme-corp", "Acme Corp", "acme"],
//   "agent":  ["helper"],
//   "people": [["Jane Doe", "jdoe", "Jane"], ["Sam Roe", "sroe"]],
//   "apps":   [["Portal", "portal"], ["Ledger", "ledger"]],
//   "hosts":  ["internal.example.com"],
//   "extra":  { "Europe/Lisbon": "<tz>", "browser-host-policy-v3": "<config-value>" },
//   "paths":  { "<org>": "acme", "<app-2>": "ledger" }
// }
// Terms match case-insensitively as whole words and as camelCase or snake_case segments
// (`withAcmeSession`, `acmeRouteAllowed`, `ACME_TOKEN`). With --project, every short or
// full commit SHA of that repository is also redacted to `<sha>`; SHAs from other
// repositories (eve's changelog) are left alone. check-report.mjs imports this module so
// excerpts are compared to source "verbatim modulo redaction".
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exact hostnames only; no subdomain wildcard, so a private workspace URL is still flagged.
export const URL_ALLOW = new Set([
  "github.com",
  "eve.dev",
  "vercel.com",
  "www.npmjs.com",
  "npmjs.com",
  "api.slack.com",
  "slack.com",
]);

export function loadMap(dir, projectRoot) {
  const file = join(dir, "anonymize.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const pairs = [];
  const add = (terms, placeholder) => {
    for (const t of Array.isArray(terms) ? terms : [terms]) if (t) pairs.push([t, placeholder]);
  };
  add(raw.org ?? [], "<org>");
  add(raw.agent ?? [], "<agent>");
  (raw.people ?? []).forEach((aliases, i) => add(aliases, `<person-${i + 1}>`));
  (raw.apps ?? []).forEach((aliases, i) => add(aliases, `<app-${i + 1}>`));
  add(raw.hosts ?? [], "<host>");
  for (const [k, v] of Object.entries(raw.extra ?? {})) pairs.push([k, v]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return { pairs, raw, shas: projectRoot ? projectShas(projectRoot) : [] };
}

function projectShas(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-list", "--all"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Whole word (case-insensitive), or a camelCase / UPPER_CASE segment of an identifier.
function patterns(term) {
  const t = esc(term);
  const out = [new RegExp(`(?<![A-Za-z0-9])${t}(?![A-Za-z0-9])`, "gi")];
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(term)) {
    const lower = esc(term.toLowerCase());
    const upper = esc(term.toUpperCase());
    const camel = esc(cap(term.toLowerCase()));
    out.push(new RegExp(`(?<=[a-z0-9])${camel}(?![a-z])`, "g")); // withAcmeSession
    out.push(new RegExp(`(?<![A-Za-z0-9])${lower}(?=[A-Z])`, "g")); // acmeRouteAllowed
    out.push(new RegExp(`(?<![A-Za-z0-9])${camel}(?=[A-Z][a-z])`, "g")); // AcmeSessionStore
    out.push(new RegExp(`(?<![A-Za-z0-9])${upper}(?=_)|(?<=_)${upper}(?![A-Za-z0-9])`, "g")); // ACME_TOKEN
  }
  return out;
}

// Built-in detectors that need no map.
const BUILTIN = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"],
  [/\b[UWTCDG](?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b/g, "<slack-id>"],
  [/\b(?:xox[abprs]|sk|ghp|gho|ghu|ghs|github_pat|AKIA)[-_][A-Za-z0-9_-]{10,}\b/g, "<token>"],
  [/\b(?=[a-f0-9]*\d)[a-f0-9]{32,}\b/g, "<hex>"],
  [
    /https?:\/\/[^\s"'`)>\]]+/g,
    (m) => {
      try {
        if (URL_ALLOW.has(new URL(m).hostname)) return m;
      } catch {}
      return "<url>";
    },
  ],
];

function shaPattern(map) {
  if (!map?.shas?.length) return null;
  return {
    re: /\b[0-9a-f]{7,40}\b/g,
    isProject: (tok) => map.shas.some((s) => s.startsWith(tok)),
  };
}

export function redact(text, map) {
  let out = text;
  for (const [term, placeholder] of map?.pairs ?? [])
    for (const re of patterns(term)) out = out.replace(re, placeholder);
  for (const [re, rep] of BUILTIN) out = out.replace(re, rep);
  const sha = shaPattern(map);
  if (sha) out = out.replace(sha.re, (tok) => (sha.isProject(tok) ? "<sha>" : tok));
  return out;
}

// Reverse the mapping inside file paths so the checker can locate files named after the
// org/app. `paths` in anonymize.json states which alias appears in filenames; without it,
// the shortest lowercase alias of each placeholder is used.
export function unredactPath(path, map) {
  if (!map) return path;
  const byPlaceholder = new Map(Object.entries(map.raw.paths ?? {}));
  for (const [term, ph] of map.pairs) {
    if (map.raw.paths?.[ph]) continue;
    if (term !== term.toLowerCase()) continue;
    const cur = byPlaceholder.get(ph);
    if (!cur || term.length < cur.length) byPlaceholder.set(ph, term);
  }
  let p = path;
  for (const [ph, term] of byPlaceholder) p = p.split(ph).join(term);
  return p;
}

export function findLeaks(text, map) {
  const leaks = [];
  const sha = shaPattern(map);
  text.split("\n").forEach((line, i) => {
    for (const [term] of map?.pairs ?? []) {
      if (patterns(term).some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(line)))
        leaks.push({ line: i + 1, what: term });
    }
    for (const [re] of BUILTIN) {
      for (const hit of line.match(re) ?? []) {
        if (re.source.startsWith("https?")) {
          try {
            if (URL_ALLOW.has(new URL(hit).hostname)) continue;
          } catch {}
        }
        leaks.push({ line: i + 1, what: hit });
      }
    }
    if (sha)
      for (const tok of line.match(sha.re) ?? [])
        if (sha.isProject(tok)) leaks.push({ line: i + 1, what: `project commit ${tok}` });
  });
  return leaks;
}

function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const report = args.find(
    (a, i) => !a.startsWith("--") && args[i - 1] !== "--map" && args[i - 1] !== "--project",
  );
  const mapDir = opt("--map") ?? ".eve-friction";
  const map = loadMap(mapDir, opt("--project"));
  if (!report) {
    console.error("usage: redact.mjs <report.md> --map <dir> [--project <root>] [--check]");
    process.exit(2);
  }
  if (!map) {
    console.error(`no anonymize.json in ${mapDir}`);
    process.exit(2);
  }
  const text = readFileSync(report, "utf8");
  if (args.includes("--check")) {
    const leaks = findLeaks(text, map);
    for (const l of leaks) console.error(`line ${l.line}: ${l.what}`);
    if (leaks.length) process.exit(1);
    console.log("redact: no leaks");
  } else {
    const out = redact(text, map);
    writeFileSync(report, out);
    const leaks = findLeaks(out, map);
    console.log(`redact: rewrote ${report}; ${leaks.length} residual leak(s)`);
    for (const l of leaks) console.error(`line ${l.line}: ${l.what}`);
    process.exit(leaks.length ? 1 : 0);
  }
}
