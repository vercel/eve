import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRolldownVersion } from "./rolldown.mjs";
import { collectFilesRecursively, findPackageJson, runVendor } from "./vendor-compiled/_shared.mjs";
import { MODULES } from "./vendor-compiled/index.mjs";
import { syncExtensions } from "./sync-extensions.mjs";
import { workflowWorldLocalStreamReadPlugin } from "./workflow-world-local-stream-reads.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageRoot = dirname(here);
const compiledRoot = join(packageRoot, ".generated", "compiled");
const vendorCompiledDir = join(here, "vendor-compiled");
const modules = MODULES.map((module) =>
  module.packageName === "@workflow/world-local"
    ? { ...module, plugins: [...(module.plugins ?? []), workflowWorldLocalStreamReadPlugin] }
    : module,
);

const scriptFiles = [
  fileURLToPath(import.meta.url),
  join(packageRoot, "package.json"),
  join(here, "rolldown.mjs"),
  join(packageRoot, "src", "internal", "bundler", "vendored-dependency-log.ts"),
  join(here, "workflow-world-local-stream-reads.mjs"),
  ...(await collectFilesRecursively(vendorCompiledDir, [".mjs", ".d.ts"])),
];

await syncExtensions();

const envRunner = await findPackageJson("env-runner", packageRoot);
const envRunnerServerVersions = Object.fromEntries(
  await Promise.all(
    ["crossws", "srvx"].map(async (name) => [
      `env-runner>${name}`,
      (await findPackageJson(name, envRunner.packageRoot)).packageJson.version,
    ]),
  ),
);

await runVendor({
  packageRoot,
  compiledRoot,
  modules,
  scriptFiles,
  toolVersions: {
    ...envRunnerServerVersions,
    rolldown: resolveRolldownVersion(),
    typescript: require("typescript/package.json").version,
  },
});
