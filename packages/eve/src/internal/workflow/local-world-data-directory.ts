import { join, relative } from "node:path";
import { resolveDevelopmentStateDirectory } from "#internal/application/dev-environment.js";

export function resolveLocalWorkflowWorldDataDirectory(appRoot: string): string {
  return join(resolveDevelopmentStateDirectory(appRoot), ".workflow-data");
}

/** App-relative store path for messages that name the directory to inspect or remove. */
export function displayLocalWorkflowWorldDataDirectory(appRoot: string): string {
  return relative(appRoot, resolveLocalWorkflowWorldDataDirectory(appRoot)).replaceAll("\\", "/");
}
