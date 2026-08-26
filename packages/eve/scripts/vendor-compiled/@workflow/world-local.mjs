import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { loadDeclaration } from "../_shared.mjs";

const require = createRequire(import.meta.url);

function resolveWorkflowWorldLocalVersion() {
  let currentPath = dirname(require.resolve("@workflow/world-local"));

  while (true) {
    const manifestPath = join(currentPath, "package.json");

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

      if (manifest.name === "@workflow/world-local" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch {
      // Keep walking toward the package root.
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      throw new Error("Failed to resolve @workflow/world-local package version.");
    }

    currentPath = parentPath;
  }
}

const workflowWorldLocalVersion = resolveWorkflowWorldLocalVersion();

const workflowWorldLocalVersionPlugin = {
  name: "eve-workflow-world-local-version",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/@workflow/world-local/dist/init.js")) {
      return undefined;
    }

    const bundledVersionSource = "version: 'bundled',";
    if (!source.includes(bundledVersionSource)) {
      throw new Error("Failed to find the bundled @workflow/world-local version fallback.");
    }

    return {
      code: source.replace(
        bundledVersionSource,
        `version: ${JSON.stringify(workflowWorldLocalVersion)},`,
      ),
      map: null,
    };
  },
};

const GRACEFUL_AGENT_CLOSE_SOURCE = "await httpAgent?.close();";
const ABORTING_AGENT_CLOSE_SOURCE = "await httpAgent?.destroy();";

function createAbortingQueueShutdownPlugin() {
  let patched = false;

  return {
    name: "eve-workflow-world-local-aborting-queue-shutdown",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@workflow/world-local/dist/queue.js")) {
        return undefined;
      }
      if (!source.includes(GRACEFUL_AGENT_CLOSE_SOURCE)) {
        throw new Error("@workflow/world-local's queue shutdown contract changed.");
      }
      patched = true;
      return {
        code: source.replace(GRACEFUL_AGENT_CLOSE_SOURCE, ABORTING_AGENT_CLOSE_SOURCE),
        map: null,
      };
    },
    buildEnd() {
      if (!patched) {
        throw new Error("@workflow/world-local's queue shutdown was not patched.");
      }
    },
  };
}

export default {
  packageName: "@workflow/world-local",
  compiledPath: "@workflow/world-local",
  chunkGroup: "workflow",
  declaration: await loadDeclaration("workflow-world-local.d.ts"),
  plugins: [workflowWorldLocalVersionPlugin, createAbortingQueueShutdownPlugin()],
};
