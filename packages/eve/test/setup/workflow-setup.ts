import { join } from "node:path";

import { afterAll } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import { openTestWorld } from "#internal/testing/workflow-test-world.js";
import { resolveWorkflowTestOutputDirectory } from "#internal/testing/workflow-vitest-plugin.js";
import {
  deriveEveWorkflowQueueNamespace,
  deriveEveWorkflowQueuePrefix,
  installEveWorkflowQueueNamespace,
} from "#internal/workflow/queue-namespace.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

import { WORKFLOW_TEST_AGENT_NAME } from "./workflow-global-setup.js";
import { resetWorkflowProcessCaches } from "./workflow-process-caches.js";

const packageRoot = resolvePackageRoot();
const poolId = process.env.VITEST_POOL_ID ?? "0";
installEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME);
resetWorkflowProcessCaches();
const world = await openTestWorld({
  outDir: resolveWorkflowTestOutputDirectory(packageRoot),
  namespace: deriveEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME),
  dataDir: join(resolveLocalWorkflowWorldDataDirectory(packageRoot), `vitest-${poolId}`),
  prefix: deriveEveWorkflowQueuePrefix(WORKFLOW_TEST_AGENT_NAME),
  tag: `vitest-${poolId}`,
});

afterAll(async () => {
  await world.close();
});
