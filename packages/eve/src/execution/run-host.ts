import type {
  AgentSessionMessage,
  AgentSessionOpenInput,
  AgentSessionReceipt,
  OpenedAgentSession,
  StartedAgentSession,
} from "#execution/agent-sessions/start.js";
import type { ToolStubHost } from "#execution/tool-stub-host.js";

export interface RunHook<T> extends AsyncIterable<T> {
  readonly token: string;
  claim(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface RunAgentSessions {
  open(input: AgentSessionOpenInput): Promise<StartedAgentSession>;
  send(input: AgentSessionMessage & OpenedAgentSession): Promise<AgentSessionReceipt>;
  cancelTurn(opened: OpenedAgentSession): Promise<void>;
  end(input: { readonly sessions: readonly OpenedAgentSession[] }): Promise<void>;
  stopLate(opened: OpenedAgentSession): Promise<void>;
}

export interface RunHost {
  runId(): string;
  createHook<T>(token?: string): RunHook<T>;
  createRemoteReplyHook<T>(): Promise<RunHook<T>>;
  sleep(ms: number): Promise<void>;
  resumeHook(
    token: string,
    payload: unknown,
    options?: { readonly ifPresent?: boolean },
  ): Promise<void>;
  readonly agentSessions: RunAgentSessions;
  resolveWorkflow?(workflowId: string): unknown;
  readonly toolStubs?: ToolStubHost;
}
