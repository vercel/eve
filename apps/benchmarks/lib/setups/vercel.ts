import { readFileSync } from "node:fs";

import type { AuthoringSetup } from "../authoring-case.js";
import { AUTHORING_EVAL_DIRECTORY_ENV } from "../paths.js";

const mockVercel = readFileSync(new URL("./mock-vercel-cli.mjs", import.meta.url), "utf8");

/**
 * Installs the deterministic Vercel CLI fixture as the project's local `vercel`
 * binary, which eve prefers over a global one. The wrapper carries the world
 * events directory, since the model's shell does not.
 */
export const vercelSetup: AuthoringSetup = {
  id: "vercel-v2",
  async onSession({ workspace, artifactsRoot, run, write }) {
    const mockPath = `${artifactsRoot}/mock-vercel-cli.mjs`;
    const vercelPath = `${workspace}/node_modules/.bin/vercel`;
    await run(`mkdir -p ${artifactsRoot} ${workspace}/node_modules/.bin`);
    await write(mockPath, mockVercel);
    await write(
      vercelPath,
      `#!/bin/sh\n${AUTHORING_EVAL_DIRECTORY_ENV}=${artifactsRoot} exec node ${mockPath} "$@"\n`,
    );
    await run(`chmod +x ${vercelPath}`);
  },
};
