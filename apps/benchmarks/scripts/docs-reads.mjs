// Recovers which shipped docs pages a coding agent opened during a benchmark
// run. Scaffolded projects point agents at `node_modules/eve/docs`, and agents
// reach it through read tools, `cat`/`sed`/`grep` commands, and glob or grep
// tools, so every tool input that names a docs path counts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Reads agent-eval's parsed `transcript.json`. agent-eval writes it for every
 * harness (Claude Code, Codex, OpenCode), so callers do not depend on any one
 * harness's raw event shape.
 */
export function readTranscript(runPath) {
  const path = join(runPath, "transcript.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

export function transcriptToolCalls(transcript) {
  const events = Array.isArray(transcript?.events) ? transcript.events : [];
  return events
    .filter((event) => event.type === "tool_call" && event.tool !== undefined)
    .map((event) => {
      const args = event.tool.args ?? {};
      const command = [args._extractedCommand, args.command, args.cmd].find(
        (value) => typeof value === "string",
      );
      return {
        name: event.tool.name,
        command,
        paths: [args._extractedPath, args.path, args.filePath, args.file_path, args.pattern].filter(
          (value) => typeof value === "string",
        ),
      };
    });
}

/**
 * Lists `docs/<page>` paths in call order. A `cat`, `sed -n`, `grep -r`, or read
 * tool path counts as one read each, and a directory listing or glob counts as a
 * `<dir>/*` probe. The first entry is the page the agent entered the docs through.
 */
export function docsSequence(toolCalls) {
  const pages = [];
  for (const call of toolCalls) {
    for (const text of new Set([call.command ?? "", ...call.paths])) {
      for (const match of text.matchAll(/eve\/docs\/([\w./-]*\.mdx?)/g)) pages.push(match[1]);
      for (const match of text.matchAll(/eve\/docs\/([\w/-]+)\/(?:\*|$|\s)/g)) {
        pages.push(`${match[1]}/*`);
      }
    }
  }
  return pages;
}

export function docsCounts(pages) {
  const counts = new Map();
  for (const page of pages) counts.set(page, (counts.get(page) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Lists the Markdown pages under `docsRoot`, which ships as `node_modules/eve/docs`. */
export function shippedDocsPages(docsRoot) {
  if (!existsSync(docsRoot)) return [];
  const pages = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.mdx?$/.test(entry.name)) pages.push(relative(docsRoot, path));
    }
  };
  walk(docsRoot);
  return pages.sort();
}

/**
 * Aggregates per-run docs reads into page usage. `runs` is the number of runs
 * that opened a page at least once, which is the usefulness signal; `reads`
 * also counts re-reads within a run. `unread` lists shipped pages no run opened.
 */
export function docsUsage(records, shippedPages) {
  const totals = new Map();
  for (const record of records) {
    for (const [page, count] of Object.entries(record.docsRead)) {
      const entry = totals.get(page) ?? { page, runs: 0, reads: 0, cases: new Set() };
      entry.runs += 1;
      entry.reads += count;
      entry.cases.add(record.case);
      totals.set(page, entry);
    }
  }
  const pages = [...totals.values()]
    .sort((a, b) => b.runs - a.runs || b.reads - a.reads || a.page.localeCompare(b.page))
    .map((entry) => ({ ...entry, cases: [...entry.cases].sort() }));
  return {
    runs: records.length,
    runsWithDocs: records.filter((record) => Object.keys(record.docsRead).length > 0).length,
    pages,
    unread: shippedPages.filter((page) => !totals.has(page)),
  };
}
