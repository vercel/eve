import type { SkillHandle } from "#execution/skills/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
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
  /**
   * Active session metadata. Mirrors the `Session` type but exposes the
   * identifier as `id` here, where `Session` names it `sessionId`.
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
  getSandbox(): Promise<SandboxSession>;

  /**
   * Returns a {@link SkillHandle} for the named authored skill.
   */
  getSkill(identifier: string): SkillHandle;
}
