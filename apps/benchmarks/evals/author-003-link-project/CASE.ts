import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

const mockVercel = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = process.env.EVE_AUTHORING_EVAL_DIRECTORY;
const args = process.argv.slice(2);
const nonInteractive = args.includes("--non-interactive");
const statePath = join(root, "vercel-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { linked: false, project: undefined };
const record = (type, data) => { mkdirSync(root, { recursive: true }); appendFileSync(join(root, "world-events.jsonl"), JSON.stringify({ type, data }) + "\n"); };
const fail = (message) => { console.error(message); process.exit(1); };
const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
record("vercel.invoked", { args, nonInteractive });
if (args[0] === "link") {
  const project = option("--project");
  if (!nonInteractive || project === undefined) fail("vercel link requires --project <name> --yes --non-interactive.");
  state.linked = true; state.project = project; writeFileSync(statePath, JSON.stringify(state)); record("project.linked", { project });
} else if (args[0] === "env" && args[1] === "pull") {
  if (!state.linked || !nonInteractive) fail("vercel env pull requires a linked project and --non-interactive.");
  writeFileSync(resolve(process.cwd(), ".env.local"), "VERCEL_OIDC_TOKEN=benchmark-token\n"); record("environment.pulled", { project: state.project });
} else if (args[0] === "deploy") {
  if (!state.linked || !nonInteractive || !args.includes("--prod")) fail("vercel deploy requires a linked project, --prod, and --non-interactive.");
  record("project.deployed", { project: state.project, url: "https://" + state.project + ".example.test" });
} else fail("Unsupported mock Vercel command: vercel " + args.join(" "));
`;

const vercelSetup = {
  id: "vercel",
  async onSession({
    workspace,
    run,
    write,
  }: {
    workspace: string;
    run(command: string): Promise<void>;
    write(path: string, content: string): Promise<void>;
  }) {
    const vercelPath = `${workspace}/node_modules/.bin/vercel`;
    await run(`mkdir -p ${workspace}/node_modules/.bin`);
    await write(vercelPath, mockVercel);
    await run(`chmod +x ${vercelPath}`);
  },
};

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: vercelSetup,
  async interact({ send }) {
    await send(
      "Execute the supported eve CLI command now to link this eve project to the existing Vercel project wayfinder-production and pull its environment. Use eve, not the raw Vercel CLI. Do not open an interactive terminal or browser. Do not stop at an explanation: run the command and report its result.",
    );
  },
});
