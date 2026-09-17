import type { SessionContext } from "#context/session-context.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { JsonObject } from "#shared/json.js";
import type { A2AEndpoint } from "#runtime/a2a/client.js";

export interface A2AInvocation {
  readonly callId: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly replyToken: string;
  readonly session: SessionContext["session"];
}
export interface A2AWorkflowInput {
  readonly source: DurableCompiledArtifactsSource;
  readonly parentNodeId?: string;
  readonly nodeId: string;
  readonly name: string;
  readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
  readonly callbackBaseUrl: string;
  readonly invocation: A2AInvocation;
}
export interface A2AOperation {
  readonly definition: A2AWorkflowInput;
  readonly endpoint?: A2AEndpoint;
  readonly method: "SendMessage" | "GetTask" | "CancelTask";
  readonly params: JsonObject;
}
export type A2ACommand =
  | {
      readonly kind: "send";
      readonly invocation: Omit<A2AInvocation, "session">;
      readonly auth: SessionContext["session"]["auth"]["current"];
    }
  | { readonly kind: "cancel" };
export function a2aControlToken(runId: string): string {
  return `eve:a2a:${runId}`;
}
