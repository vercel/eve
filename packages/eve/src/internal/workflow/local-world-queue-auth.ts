export function assertLocalWorkflowQueueAuthEnforced(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  if (env.WORKFLOW_QUEUE_AUTH?.trim().toLowerCase() !== "off") return;
  throw new Error(
    "eve start refuses WORKFLOW_QUEUE_AUTH=off with the local Workflow world: anyone who can " +
      "reach the server could then forge workflow deliveries and act as any user. Unset " +
      "WORKFLOW_QUEUE_AUTH. To serve an agent from several processes, use the Postgres world.",
  );
}
