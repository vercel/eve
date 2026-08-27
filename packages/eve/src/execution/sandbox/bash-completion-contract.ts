import type { ManagedSandboxCommandObservation } from "#execution/sandbox/managed-command.js";
import type { SandboxState } from "#sandbox/state.js";

export interface BashCompletionMonitorInput {
  readonly controlToken: string;
  readonly deliveryId: string;
  readonly processId: string;
  readonly sandboxState: SandboxState;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}

export type BashCompletionControl =
  | { readonly kind: "activate" }
  | { readonly kind: "close" }
  | { readonly kind: "kill" };

export type BashCompletionMonitorResult =
  | { readonly observation: ManagedSandboxCommandObservation; readonly status: "completed" }
  | { readonly observation: ManagedSandboxCommandObservation; readonly status: "killed" }
  | { readonly status: "closed" };

export function bashCompletionControlToken(sessionId: string, processId: string): string {
  return `eve:bash-completion:${sessionId}:${processId}`;
}

export function bashCompletionDeliveryId(sessionId: string, processId: string): string {
  return `eve:bash-completion-delivery:${sessionId}:${processId}`;
}
