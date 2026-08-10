const WORKFLOW_USE_STEP = Symbol.for("WORKFLOW_USE_STEP");
const workflowGlobal = globalThis as Record<symbol, unknown>;

/**
 * Persists correctness-critical run attributes through a throwing Workflow
 * step. Unlike telemetry attributes, unsupported storage or exhausted retries
 * must fail the workflow attempt instead of pretending the receipt exists.
 */
export async function setStrictWorkflowAttributes(
  attributes: Readonly<Record<string, string>>,
): Promise<void> {
  const useStep = workflowGlobal[WORKFLOW_USE_STEP] as
    | ((
        stepId: string,
      ) => (
        changes: ReadonlyArray<{ key: string; value: string }>,
        options: { allowReservedAttributes: true },
      ) => Promise<void>)
    | undefined;
  if (useStep === undefined) {
    throw new Error("Strict workflow attributes require an active workflow runtime.");
  }
  await useStep("__builtin_set_strict_attributes")(
    Object.entries(attributes).map(([key, value]) => ({ key, value })),
    { allowReservedAttributes: true },
  );
}
