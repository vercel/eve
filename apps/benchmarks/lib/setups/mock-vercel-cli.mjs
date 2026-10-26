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

if (args[0] === "whoami") {
  console.log("benchmark");
} else if (args[0] === "teams" && args[1] === "ls") {
  console.log(JSON.stringify({ teams: [{ name: "Benchmark", slug: "benchmark", current: true }] }));
} else if (
  args[0] === "api" &&
  args[1]?.startsWith("/v9/projects/") &&
  !args.includes("--method")
) {
  // eve looks the project up by name before linking, and reads its production
  // alias after deploying to report the URL.
  const requested = decodeURIComponent(args[1].slice("/v9/projects/".length).split("?")[0]);
  if (!state.linked || ![state.project, `prj_${state.project}`].includes(requested)) {
    console.log(JSON.stringify({ error: { code: "not_found", message: "Project not found" } }));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      id: `prj_${state.project}`,
      name: state.project,
      framework: null,
      targets: state.deployed
        ? { production: { alias: [`${state.project}.example.test`] } }
        : undefined,
    }),
  );
} else if (args[0] === "link") {
  const project = option("--project");
  if (!nonInteractive || project === undefined) {
    fail("vercel link requires --project <name> --yes --non-interactive.");
  }
  state.linked = true;
  state.project = project;
  writeFileSync(statePath, JSON.stringify(state));
  mkdirSync(resolve(process.cwd(), ".vercel"), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), ".vercel", "project.json"),
    `${JSON.stringify({ orgId: "org_benchmark", projectId: `prj_${project}`, projectName: project })}\n`,
  );
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
  state.deployed = true;
  writeFileSync(statePath, JSON.stringify(state));
  console.log(`https://${state.project}.example.test`);
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
