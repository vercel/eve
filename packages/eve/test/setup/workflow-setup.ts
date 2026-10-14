import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createWorld } from "@workflow/world-local";
import { afterAll } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import { resolveWorkflowTestOutputDirectory } from "#internal/testing/workflow-vitest-plugin.js";
import {
  deriveEveWorkflowQueuePrefix,
  installEveWorkflowQueueNamespace,
} from "#internal/workflow/queue-namespace.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";
import { setWorld } from "#internal/workflow/runtime.js";

import { WORKFLOW_TEST_AGENT_NAME } from "./workflow-global-setup.js";

const packageRoot = resolvePackageRoot();
const outDir = resolveWorkflowTestOutputDirectory(packageRoot);
const poolId = process.env.VITEST_POOL_ID ?? "0";
installEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME);
const world = createWorld({
  dataDir: join(resolveLocalWorkflowWorldDataDirectory(packageRoot), `vitest-${poolId}`),
  // Every test file in this worker shares the data directory, and the file's
  // state is cleared below. Recovering the previous file's unfinished runs on
  // start would only re-enqueue deliveries that fail before a handler exists.
  recoverActiveRuns: false,
  tag: `vitest-${poolId}`,
});

await world.start?.();
await world.clear();
const pendingDeliveries = new Set<Promise<Response>>();
world.registerHandler(
  deriveEveWorkflowQueuePrefix(WORKFLOW_TEST_AGENT_NAME),
  createLazyHandler(join(outDir, "workflows.mjs")),
);
setWorld(world);

afterAll(async () => {
  try {
    await world.close?.();
    // The local queue stops delayed deliveries on close, but does not join its
    // in-process handlers. They still need the installed world to hydrate streams.
    while (pendingDeliveries.size > 0) {
      await Promise.allSettled(pendingDeliveries);
    }
  } finally {
    setWorld(undefined);
  }
});

function createLazyHandler(bundlePath: string): (request: Request) => Promise<Response> {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let loading: Promise<(request: Request) => Promise<Response>> | undefined;

  const deliver = async (request: Request) => {
    loading ??= import(/* @vite-ignore */ pathToFileURL(bundlePath).href).then(
      (mod: { POST: (request: Request) => Promise<Response> }) => mod.POST,
    );
    handler ??= await loading;
    return await handler(request);
  };
  return async (request: Request) => {
    const delivery = deliver(request);
    pendingDeliveries.add(delivery);
    try {
      return await delivery;
    } finally {
      pendingDeliveries.delete(delivery);
    }
  };
}
