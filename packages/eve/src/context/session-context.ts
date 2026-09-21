import type { SkillHandle } from "#shared/skill-types.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import type { SessionAuth, SessionParent, SessionTurn } from "#context/keys.js";

export type { SessionAuth, SessionParent, SessionTurn };

/**
 * Shared runtime context available to all authored callbacks that run
 * inside the ALS-scoped harness step (tools, hooks, channel events).
 *
 * Non-ALS callbacks (schedule `run`, sandbox `bootstrap`/`onSession`,
 * instrumentation `setup`) do not receive this context. They get
 * domain-specific arguments instead.
 */
export interface SessionContext {
  /** Registers a destination without invoking it. Changes commit with the enclosing step. */
  registerAgent(
    destination: import("#subagents/registration.js").AgentDestination,
  ): import("#subagents/registration.js").AgentReference;
  /** Changes the next model advertisement without replacing the handle. */
  updateAgent(
    handle: import("#subagents/registration.js").AgentReference,
    description: string,
  ): void;
  /** Removes advertisement and future invocation access without cancelling accepted work. */
  unregisterAgent(handle: import("#subagents/registration.js").AgentReference): void;
  /**
   * Active session metadata for the callback's exact durable session.
   */
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
  };

  /**
   * Resolves the session's sandbox. Throws when no sandbox is available
   * in the current authored runtime context.
   */
  getSandbox(): Promise<RuntimeSandboxSession>;

  /**
   * Returns a {@link SkillHandle} for the named authored skill.
   */
  getSkill(identifier: string): SkillHandle;
}
