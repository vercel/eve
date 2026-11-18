import { join, relative } from "node:path";
import { resolveDevelopmentStateDirectory } from "#internal/application/dev-environment.js";

export function resolveLocalWorkflowWorldDataDirectory(appRoot: string): string {
  return join(resolveDevelopmentStateDirectory(appRoot), ".workflow-data");
}

export function displayLocalWorkflowWorldDataDirectory(appRoot: string): string {
  return relative(appRoot, resolveLocalWorkflowWorldDataDirectory(appRoot)).replaceAll("\\", "/");
}
