export const EVE_WORKFLOW_SPEC_VERSION = 9;

export function applyWorkflowSpecVersionDefault(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  if (isSet(env.WORKFLOW_SPEC_VERSION) || isSet(env.WORKFLOW_SEALED_LOG)) return;
  env.WORKFLOW_SPEC_VERSION = String(EVE_WORKFLOW_SPEC_VERSION);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
