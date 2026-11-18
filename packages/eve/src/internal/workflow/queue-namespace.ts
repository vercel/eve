export const WORKFLOW_QUEUE_NAMESPACE_ENV = "WORKFLOW_QUEUE_NAMESPACE";

export function deriveEveWorkflowQueueNamespace(agentName: string): string {
  const encodedAgentName = Array.from(new TextEncoder().encode(agentName), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `eve${encodedAgentName}`;
}

export function workflowQueuePrefix(namespace: string): string {
  return `__${namespace}_wkf_workflow_`;
}

export function deriveEveWorkflowQueuePrefix(agentName: string): string {
  return workflowQueuePrefix(deriveEveWorkflowQueueNamespace(agentName));
}

export function deriveEveWorkflowQueueTopic(agentName: string): string {
  return `${deriveEveWorkflowQueuePrefix(agentName)}*`;
}

export function createEveWorkflowQueueTrigger(agentName: string) {
  return {
    type: "queue/v2beta" as const,
    topic: deriveEveWorkflowQueueTopic(agentName),
    consumer: "default",
    retryAfterSeconds: 5,
    initialDelaySeconds: 0,
  };
}

export function installEveWorkflowQueueNamespace(agentName: string): string {
  const namespace = deriveEveWorkflowQueueNamespace(agentName);
  process.env[WORKFLOW_QUEUE_NAMESPACE_ENV] = namespace;
  return namespace;
}
