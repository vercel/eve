import { runMigrationChain, type VersionMigration } from "./chain.js";
import { sessionTimeoutWorkflowInputV0ToV1 } from "./session-timeout-workflow-v0-to-v1.js";

export const SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION = 1;

export interface SessionTimeoutWorkflowInput {
  readonly deadline: Date;
  readonly token: string;
  readonly version: typeof SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION;
}

export type SessionTimeoutWorkflowDispatchInput = Omit<SessionTimeoutWorkflowInput, "version">;

const sessionTimeoutWorkflowInputMigrations: readonly VersionMigration[] = [
  sessionTimeoutWorkflowInputV0ToV1,
];

export function createSessionTimeoutWorkflowInput(
  input: SessionTimeoutWorkflowDispatchInput,
): SessionTimeoutWorkflowInput {
  return { ...input, version: SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION };
}

export function migrateSessionTimeoutWorkflowInput(value: unknown): SessionTimeoutWorkflowInput {
  return runMigrationChain<SessionTimeoutWorkflowInput>({
    initialVersion: 0,
    label: "session timeout workflow input",
    migrations: sessionTimeoutWorkflowInputMigrations,
    targetVersion: SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION,
    value,
  });
}
