import { basename } from "node:path";

import { installLocalInstrumentationRuntime } from "#tracing/local/instrumentation-runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";

/** Captures a dev worker's traces locally when the agent has no authored instrumentation. */
export function installLocalTracing(nitroApp: {
  readonly hooks: { hook(name: "close", handler: () => Promise<void>): unknown };
}): void {
  const appRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  if (appRoot === undefined) {
    throw new Error(`${DEVELOPMENT_WORKER_APP_ROOT_ENV} is required for local tracing.`);
  }
  const runtime = installLocalInstrumentationRuntime({
    appRoot,
    frameworkVersion: resolveInstalledPackageInfo().version,
    serviceName: basename(appRoot),
  });
  nitroApp.hooks.hook("close", () => runtime.shutdown());
}
