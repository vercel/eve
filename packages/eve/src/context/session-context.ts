import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";
import type { SessionAuth, SessionParent, SessionPredecessor, SessionTurn } from "#context/keys.js";

import type { SessionSchedule } from "#context/session-schedule.js";
import type { ConversationContext } from "#shared/conversation-context.js";
export type { SessionAuth, SessionParent, SessionPredecessor, SessionSchedule, SessionTurn };

/** Options for {@link SessionContext.getSandbox}. */
export interface GetSandboxOptions {
  /**
   * Whether to create a new sandbox when the session does not have one yet.
   * Defaults to `true`.
   *
   * When `false`, resolves to `null` instead of creating a new sandbox if this
   * session has never started one, if its sandbox was deleted, or if a
   * previously persisted sandbox is gone; resumes an idle-stopped persisted
   * sandbox if one exists.
   */
  readonly create?: boolean;
}

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
   * Where the session's conversation happens: the channel that created it,
   * its audience, and, when the channel reports one, its `space`, such as the
   * Slack channel a thread is in. Absent on sessions persisted before eve
   * recorded it.
   */
  readonly conversation?: ConversationContext;

  /**
   * Resolves the session's sandbox. Throws when no sandbox is available
   * in the current authored runtime context.
   */
  getSandbox(options?: { readonly create?: true }): Promise<RuntimeSandboxSession>;
  /**
   * Resolves the session's sandbox, or returns `null` without creating one
   * when `options.create` is `false` and the session does not have a sandbox.
   */
  getSandbox(options?: GetSandboxOptions): Promise<RuntimeSandboxSession | null>;
  /**
   * Resolves the session's sandbox with the capabilities declared by its
   * configured environment. Throws when the environment is not active.
   */
  getSandbox<Session extends SandboxSession>(
    environment: SandboxEnvironment<object | undefined, Session>,
    options: { readonly create?: true } | undefined,
  ): Promise<RuntimeSandboxSession<Session>>;
  /**
   * Resolves the session's sandbox with the capabilities declared by its
   * configured environment, or returns `null` without creating one when
   * `options.create` is `false` and the session does not have a sandbox. Throws
   * when the environment is not active.
   */
  getSandbox<Session extends SandboxSession>(
    environment: SandboxEnvironment<object | undefined, Session>,
    options: GetSandboxOptions | undefined,
  ): Promise<RuntimeSandboxSession<Session> | null>;
  /**
   * Resolves the session's sandbox with the capabilities declared by its
   * configured environment. Throws when the environment is not active.
   */
  getSandbox<Session extends SandboxSession>(
    environment: SandboxEnvironment<object | undefined, Session>,
  ): Promise<RuntimeSandboxSession<Session>>;
}

/** Active session metadata observed by authored callbacks as `ctx.session`. */
export type SessionInfo = SessionContext["session"];
