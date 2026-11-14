import type {
  AgentSessionMessage,
  AgentSessionOpenInput,
  AgentSessionReceipt,
  OpenedAgentSession,
  StartedAgentSession,
} from "#execution/agent-sessions/start.js";
import type { ToolStubHost } from "#execution/tool-stub-host.js";

// What a workflow tool run needs from the host it runs on: its own id, the hooks it listens on,
// a clock, a way to resume the hooks others listen on, and the sessions its `ctx.agent` opens.
// Workflow runs a run as a durable workflow (`tools/workflow/workflow-run-host.ts`); the
// in-process host runs the same body as a task in its process. The body and the run's owner
// loop read only this.

/** One address the run listens on: what arrives on it, in order. */
export interface RunHook<T> extends AsyncIterable<T> {
  readonly token: string;
  /** Resolves `false` when another run already holds the hook's token. */
  claim(): Promise<boolean>;
  /** Closes the hook; what arrives for its token later is refused. */
  dispose(): Promise<void>;
}

/** How a run opens, sends to, and ends the agent sessions its body opens. */
export interface RunAgentSessions {
  open(input: AgentSessionOpenInput): Promise<StartedAgentSession>;
  send(input: AgentSessionMessage & OpenedAgentSession): Promise<AgentSessionReceipt>;
  /** Cancels a session's running turn, best effort; the turn still reports, as cancelled. */
  cancelTurn(opened: OpenedAgentSession): Promise<void>;
  /** Ends the run's sessions when it finishes, best effort. */
  end(input: { readonly sessions: readonly OpenedAgentSession[] }): Promise<void>;
  /** Stops a session the run opened too late to own, best effort. */
  stopLate(opened: OpenedAgentSession): Promise<void>;
}

export interface RunHost {
  /** The run's id, which names it to its session and in what it sends. */
  runId(): string;
  /** Opens a hook, under `token` or one the host names. */
  createHook<T>(token?: string): RunHook<T>;
  /** Resolves once `ms` pass. */
  sleep(ms: number): Promise<void>;
  /**
   * Resumes the hook `token` names, such as the session's inbox. With `ifPresent`, a hook that's
   * gone is ignored.
   */
  resumeHook(
    token: string,
    payload: unknown,
    options?: { readonly ifPresent?: boolean },
  ): Promise<void>;
  readonly agentSessions: RunAgentSessions;
  /**
   * The body a workflow id names, when the host holds bodies itself. Workflow's are registered
   * by its bundle; one this returns `undefined` for is looked up there.
   */
  resolveWorkflow?(workflowId: string): unknown;
  /** Answers a stubbed eval's calls from the run; see {@link ToolStubHost}. */
  readonly toolStubs?: ToolStubHost;
}
