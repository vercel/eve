import { join } from "node:path";

export const LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH = ".eve/.workflow-data";

export function resolveLocalWorkflowWorldDataDirectory(appRoot: string): string {
  return join(appRoot, LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH);
}
