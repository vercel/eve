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
      "Use the eve CLI to link this project to the existing Vercel project wayfinder-production and deploy it to production. This must be safe for CI: do not wait for terminal input or open a browser.",
    );
  },
});
