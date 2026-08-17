#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.env.EVE_AUTHORING_EVAL_DIRECTORY;
if (root === undefined) throw new Error("EVE_AUTHORING_EVAL_DIRECTORY is required.");

const args = process.argv.slice(2);
const nonInteractive = args.includes("--non-interactive");
const statePath = join(root, "vercel-state.json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { linked: false, project: undefined };

record("vercel.invoked", { args, nonInteractive });

if (args[0] === "link") {
  const project = option("--project");
  if (!nonInteractive || project === undefined) {
    fail("vercel link requires --project <name> --yes --non-interactive.");
  }
  state.linked = true;
  state.project = project;
  writeFileSync(statePath, JSON.stringify(state));
  record("project.created", { project });
  record("project.linked", { project });
} else if (args[0] === "env" && args[1] === "pull") {
  if (!state.linked || !nonInteractive) {
    fail("vercel env pull requires a linked project and --non-interactive.");
  }
  writeFileSync(resolve(process.cwd(), ".env.local"), "VERCEL_OIDC_TOKEN=benchmark-token\n");
  record("environment.pulled", { project: state.project });
} else if (args[0] === "deploy") {
  if (!state.linked || !nonInteractive || !args.includes("--prod")) {
    fail("vercel deploy requires a linked project, --prod, and --non-interactive.");
  }
  record("project.deployed", {
    project: state.project,
    url: `https://${state.project}.example.test`,
  });
} else {
  fail(`Unsupported mock Vercel command: vercel ${args.join(" ")}`);
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function record(type, data) {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, "world-events.jsonl"), `${JSON.stringify({ type, data })}\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
