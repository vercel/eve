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
  recoverActiveRuns: false,
  tag: `vitest-${poolId}`,
});

await world.start?.();
await world.clear();
const deliveries = trackDeliveries(createLazyHandler(join(outDir, "workflows.mjs")));
world.registerHandler(deriveEveWorkflowQueuePrefix(WORKFLOW_TEST_AGENT_NAME), deliveries.handler);
setWorld(world);

afterAll(async () => {
  await deliveries.close();
  await world.close?.();
  setWorld(undefined);
});

function trackDeliveries(handle: (request: Request) => Promise<Response>) {
  const running = new Set<Promise<Response>>();
  let closing = false;
  return {
    async handler(request: Request): Promise<Response> {
      if (closing) throw new DOMException("The test workflow world is closing.", "AbortError");
      const delivery = handle(request);
      running.add(delivery);
      try {
        return await delivery;
      } finally {
        running.delete(delivery);
      }
    },
    async close(): Promise<void> {
      closing = true;
      const deadline = Date.now() + 5_000;
      while (running.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled(running),
          new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
        ]);
      }
    },
  };
}

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
