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

const packageRoot = resolvePackageRoot();
const poolId = process.env.VITEST_POOL_ID ?? "0";
installEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME);
// Every test file in this worker shares the data directory, and the file's state is cleared as
// the World opens, so it doesn't recover the previous file's unfinished runs.
const world = await openTestWorld({
  outDir: resolveWorkflowTestOutputDirectory(packageRoot),
  namespace: deriveEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME),
  dataDir: join(resolveLocalWorkflowWorldDataDirectory(packageRoot), `vitest-${poolId}`),
  prefix: deriveEveWorkflowQueuePrefix(WORKFLOW_TEST_AGENT_NAME),
  tag: `vitest-${poolId}`,
});

afterAll(async () => {
  // A test can end while its session still runs, such as one that dispatches a reset and
  // returns. Clearing the world under that delivery fails it in places nothing awaits, like a
  // stream it hydrates, and Vitest reports the rejection as an unhandled error. The World refuses
  // new deliveries and lets the in-flight ones settle first.
  await world.close();
});
