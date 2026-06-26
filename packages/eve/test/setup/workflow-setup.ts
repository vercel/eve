import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createLocalWorld } from "@workflow/world-local";
import { afterAll } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import { resolveWorkflowTestOutputDirectory } from "#internal/testing/workflow-vitest-plugin.js";
import {
  deriveEveWorkflowQueuePrefix,
  installEveWorkflowQueueNamespace,
} from "#internal/workflow/queue-namespace.js";
import { setWorld } from "#internal/workflow/runtime.js";

import { WORKFLOW_TEST_AGENT_NAME } from "./workflow-global-setup.js";

const packageRoot = resolvePackageRoot();
const outDir = resolveWorkflowTestOutputDirectory(packageRoot);
const poolId = process.env.VITEST_POOL_ID ?? "0";
installEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME);
const world = createLocalWorld({
  dataDir: join(packageRoot, ".workflow-data"),
  tag: `vitest-${poolId}`,
});

await world.start?.();
await world.clear();
world.registerHandler(
  deriveEveWorkflowQueuePrefix(WORKFLOW_TEST_AGENT_NAME),
  createLazyHandler(join(outDir, "workflows.mjs")),
);
setWorld(world);

afterAll(async () => {
  setWorld(undefined);
  await world.close?.();
});

function createLazyHandler(bundlePath: string): (request: Request) => Promise<Response> {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let loading: Promise<(request: Request) => Promise<Response>> | undefined;

  return async (request: Request) => {
    loading ??= import(/* @vite-ignore */ pathToFileURL(bundlePath).href).then(
      (mod: { POST: (request: Request) => Promise<Response> }) => mod.POST,
    );
    handler ??= await loading;
    return await handler(request);
  };
}
