import type { RunInput } from "#channel/types.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";
import { workflowEntryInputV0ToV1 } from "./workflow-entry-v0-to-v1.js";

export const WORKFLOW_ENTRY_INPUT_VERSION = 1;

export interface WorkflowEntryInput {
  readonly input: RunInput["input"];
  readonly limits?: RunInput["limits"];
  readonly sessionTimeoutMs?: number | false;
  readonly serializedContext: Record<string, unknown>;
  readonly version: typeof WORKFLOW_ENTRY_INPUT_VERSION;
}

export type WorkflowEntryDispatchInput = Omit<WorkflowEntryInput, "version">;

const workflowEntryInputMigrations: readonly VersionMigration[] = [workflowEntryInputV0ToV1];

export function createWorkflowEntryInput(input: WorkflowEntryDispatchInput): WorkflowEntryInput {
  return { ...input, version: WORKFLOW_ENTRY_INPUT_VERSION };
}

export function migrateWorkflowEntryInput(value: unknown): WorkflowEntryInput {
  return runMigrationChain<WorkflowEntryInput>({
    initialVersion: 0,
    label: "workflow entry input",
    migrations: workflowEntryInputMigrations,
    targetVersion: WORKFLOW_ENTRY_INPUT_VERSION,
    value,
  });
}
