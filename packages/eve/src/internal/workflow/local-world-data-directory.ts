import { join } from "node:path";
import { resolveDevelopmentStateDirectory } from "#internal/application/dev-environment.js";

export const LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH = ".eve/.workflow-data";

export function resolveLocalWorkflowWorldDataDirectory(appRoot: string): string {
  return join(resolveDevelopmentStateDirectory(appRoot), ".workflow-data");
}
