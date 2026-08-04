import { basename } from "node:path";

import { installLocalInstrumentationRuntime } from "#tracing/local-instrumentation-runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";

const appRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
if (appRoot === undefined) {
  throw new Error(`${DEVELOPMENT_WORKER_APP_ROOT_ENV} is required for local tracing.`);
}

installLocalInstrumentationRuntime({
  appRoot,
  frameworkVersion: resolveInstalledPackageInfo().version,
  serviceName: basename(appRoot),
});

export default function installLocalTracingRuntimePlugin(): void {}
