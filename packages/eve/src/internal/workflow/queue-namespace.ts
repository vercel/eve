export const WORKFLOW_QUEUE_NAMESPACE_ENV = "WORKFLOW_QUEUE_NAMESPACE";

/** Derives a stable Workflow queue namespace from an eve agent's unique name. */
export function deriveEveWorkflowQueueNamespace(agentName: string): string {
  const encodedAgentName = Array.from(new TextEncoder().encode(agentName), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `eve${encodedAgentName}`;
}

/** Derives the queue prefix consumed by an eve agent's workflow handler. */
export function deriveEveWorkflowQueuePrefix(agentName: string): string {
  return `__${deriveEveWorkflowQueueNamespace(agentName)}_wkf_workflow_`;
}

/** Derives the queue topic registered for an eve agent's workflow handler. */
export function deriveEveWorkflowQueueTopic(agentName: string): string {
  return `${deriveEveWorkflowQueuePrefix(agentName)}*`;
}

/** Installs the agent-scoped namespace used by Workflow runtime operations. */
export function installEveWorkflowQueueNamespace(agentName: string): string {
  const namespace = deriveEveWorkflowQueueNamespace(agentName);
  process.env[WORKFLOW_QUEUE_NAMESPACE_ENV] = namespace;
  return namespace;
}
