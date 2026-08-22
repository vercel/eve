import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuthoringSetup } from "../lib/authoring-case.js";

const mockVercel = readFileSync(join(import.meta.dirname, "mock-vercel-cli.mjs"), "utf8");

/** Installs the deterministic Vercel CLI fixture beside the project's local binaries. */
export const vercelSetup: AuthoringSetup = {
  id: "vercel",
  async onSession({ workspace, run, write }) {
    const vercelPath = `${workspace}/node_modules/.bin/vercel`;
    await run(`mkdir -p ${workspace}/node_modules/.bin`);
    await write(vercelPath, mockVercel);
    await run(`chmod +x ${vercelPath}`);
  },
};
