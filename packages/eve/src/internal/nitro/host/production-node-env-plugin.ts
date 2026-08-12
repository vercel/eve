import { defaultNodeEnv } from "#internal/application/dev-environment.js";

/**
 * Defaults `NODE_ENV` to `production` at server boot for a built server
 * launched directly (for example `node .output/server/index.mjs`) rather than
 * through `eve start`. An explicit `NODE_ENV` is left untouched.
 */
export default function productionNodeEnvPlugin(): void {
  defaultNodeEnv("production");
}
