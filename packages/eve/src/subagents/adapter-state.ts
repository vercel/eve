export const SUBAGENT_ADAPTER_KIND = "subagent";

export interface DirectSubagentTaskRef {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId: string;
  readonly toolName: string;
  readonly turnId: string;
}

export interface SubagentAdapterState extends Record<string, unknown> {
  readonly callId: string;
  readonly directTask?: DirectSubagentTaskRef;
  readonly parentContinuationToken: string;
  readonly parentSessionId: string;
  readonly subagentName: string;
}

export function isDirectSubagentTaskRef(value: unknown): value is DirectSubagentTaskRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as Partial<DirectSubagentTaskRef>;
  return (
    typeof ref.sequence === "number" &&
    typeof ref.stepIndex === "number" &&
    typeof ref.taskId === "string" &&
    ref.taskId.length > 0 &&
    typeof ref.toolName === "string" &&
    ref.toolName.length > 0 &&
    typeof ref.turnId === "string" &&
    ref.turnId.length > 0
  );
}

export function isSubagentAdapterState(value: unknown): value is SubagentAdapterState {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<SubagentAdapterState>;

  return (
    typeof state.callId === "string" &&
    state.callId.length > 0 &&
    typeof state.parentContinuationToken === "string" &&
    state.parentContinuationToken.length > 0 &&
    typeof state.parentSessionId === "string" &&
    typeof state.subagentName === "string" &&
    state.subagentName.length > 0
  );
}
