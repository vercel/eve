import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import type {
  RuntimeSandboxSession,
  RuntimeSandboxSessionFor,
  SandboxSession,
} from "#shared/sandbox-session.js";
import type { SessionAuth, SessionParent, SessionPredecessor, SessionTurn } from "#context/keys.js";

import type { SessionSchedule } from "#context/session-schedule.js";
export type { SessionAuth, SessionParent, SessionPredecessor, SessionSchedule, SessionTurn };

/**
 * Shared runtime context available to all authored callbacks that run
 * inside the ALS-scoped harness step (tools, hooks, channel events).
 *
 * Non-ALS callbacks (schedule `run` and provider environment preparation,
 * instrumentation `setup`) do not receive this context. They get
 * domain-specific arguments instead.
 */
export interface SessionContext {
  /**
   * Active session metadata for the callback's exact durable session.
   */
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
    /** Present only for scheduled work; not an application-supplied auth attribute. */
    readonly schedule?: SessionSchedule;
    /**
     * Present when eve started this session in place of one whose deployment
     * was retired. It names the earlier session, whose recorded stream
     * `sessions.attach(predecessor.sessionId)` from `eve/server` reads.
     */
    readonly predecessor?: SessionPredecessor;
  };

  /**
   * Resolves the session's sandbox. Throws when no sandbox is available
   * in the current authored runtime context.
   */
  getSandbox(): Promise<RuntimeSandboxSession>;
  /**
   * Resolves the session's sandbox with the capabilities declared by its
   * configured environment. Throws when the environment is not active.
   */
  getSandbox<Session extends SandboxSession>(
    environment: SandboxEnvironment<object | undefined, Session>,
  ): Promise<RuntimeSandboxSessionFor<Session>>;
}
