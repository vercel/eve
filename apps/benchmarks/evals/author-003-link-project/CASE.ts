import { readFileSync } from "node:fs";

import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

const mockVercel = readFileSync(new URL("../mock-vercel-cli.mjs", import.meta.url), "utf8");

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
