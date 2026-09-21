import type { SubagentSession } from "./subagent-session.ts";

/** Add a view's serializable payload here and its renderer to the host registry. */
export interface WorkspacePanePayloads {
  subagent: SubagentSession;
}
export type WorkspacePane = {
  [K in keyof WorkspacePanePayloads]: {
    kind: K;
    payload: WorkspacePanePayloads[K];
    rootSessionId?: string;
  };
}[keyof WorkspacePanePayloads];

export function readWorkspacePane(raw: string | null, parent: string): WorkspacePane | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value?.kind !== "subagent") return;
    const s = value.payload;
    if (
      (value.rootSessionId ?? s?.sessionId) !== parent ||
      typeof s?.sessionId !== "string" ||
      typeof s.childSessionId !== "string" ||
      typeof s.callId !== "string" ||
      typeof s.name !== "string" ||
      (s.remote !== undefined && typeof s.remote?.url !== "string")
    )
      return;
    return value;
  } catch {
    return;
  }
}
