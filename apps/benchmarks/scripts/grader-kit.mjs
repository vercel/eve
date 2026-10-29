#!/usr/bin/env node

// Copies lib/grader-kit.ts between the grader-kit markers of every evals/*/EVAL.ts that has
// them. agent-eval hides only files named EVAL.ts from the agent, so each grader has to carry
// its own copy; this keeps the copies identical to the one source.
//
// Usage: node scripts/grader-kit.mjs [--check]
//   --check  exit 1, listing graders whose copy is out of date, without writing

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BEGIN =
  "// ---- grader-kit: copied from apps/benchmarks/lib/grader-kit.ts by `pnpm grader-kit:sync`. Edit it there. ----";
export const END = "// ---- end grader-kit ----";

/** The graders with a grader-kit block, and whether each copy matches the source. */
export function graderKitCopies(root = appRoot) {
  const kit = readFileSync(join(root, "lib/grader-kit.ts"), "utf8").trimEnd();
  const evalsRoot = join(root, "evals");
  const copies = [];
  for (const entry of readdirSync(evalsRoot, { withFileTypes: true })) {
    const path = join(evalsRoot, entry.name, "EVAL.ts");
    if (!entry.isDirectory() || !existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const begin = source.indexOf(BEGIN);
    if (begin === -1) continue;
    const end = source.indexOf(END, begin);
    if (end === -1) throw new Error(`${path} has a grader-kit start marker but no end marker.`);
    const synced = `${source.slice(0, begin)}${BEGIN}\n${kit}\n${source.slice(end)}`;
    copies.push({ path, current: synced === source, synced });
  }
  return copies;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = graderKitCopies().filter((copy) => !copy.current);
  if (check) {
    for (const copy of stale) console.error(`Out of date: ${copy.path}`);
    if (stale.length > 0) {
      console.error("Run `pnpm grader-kit:sync` in apps/benchmarks.");
      process.exit(1);
    }
  } else {
    for (const copy of stale) {
      writeFileSync(copy.path, copy.synced);
      console.error(`Synced ${copy.path}`);
    }
  }
}
