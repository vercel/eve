import type { SessionContext } from "#context/session-context.js";
import type { SkillHandle } from "#shared/skill-types.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";
import { createSandboxSkillHandle } from "#runtime/skills/sandbox-access.js";
import { loadContext } from "#context/container.js";
import { SandboxKey, SessionKey } from "#context/keys.js";

/**
 * Builds a {@link SessionContext} from the active ALS scope.
 *
 * Must be called inside a harness step (active `contextStorage.run`).
 * Throws when called outside an ALS scope.
 */
export function buildCallbackContext(): SessionContext {
  const ctx = loadContext();
  const session = ctx.require(SessionKey);

  return {
    session: {
      id: session.sessionId,
      auth: session.auth,
      turn: session.turn,
      parent: session.parent,
    },

    getSandbox(): Promise<RuntimeSandboxSession> {
      const access = ctx.get(SandboxKey);
      if (access === undefined) {
        throw new Error(
          "eve sandbox runtime access is unavailable in the current async context. " +
            "Call ctx.getSandbox() only from authored runtime functions such as tools, hooks, and channel events.",
        );
      }
      return access.get().then((sandbox) => {
        if (sandbox === null) {
          throw new Error("The sandbox is not available in the current authored runtime context.");
        }
        return withRuntimeSandboxLifecycle(
          sandbox,
          async (options) => {
            if (access.delete === undefined) {
              throw new Error("The active sandbox runtime does not support deletion.");
            }
            await access.delete(options);
          },
          async () => await access.stop(),
        );
      });
    },

    getSkill(identifier: string): SkillHandle {
      const access = ctx.get(SandboxKey);
      if (access === undefined) {
        throw new Error(
          "eve sandbox runtime access is unavailable in the current async context. " +
            "Call ctx.getSkill() only from authored runtime functions such as tools, hooks, and channel events.",
        );
      }
      return createSandboxSkillHandle(access, identifier);
    },
  };
}

export function withRuntimeSandboxLifecycle<Session extends SandboxSession>(
  sandbox: Session,
  deleteSandbox: RuntimeSandboxSession["delete"],
  stop: () => Promise<void>,
): Session & Pick<RuntimeSandboxSession, "delete" | "stop"> {
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "delete") return deleteSandbox;
      if (property === "stop") return stop;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return property === "delete" || property === "stop" || Reflect.has(target, property);
    },
  }) as Session & Pick<RuntimeSandboxSession, "delete" | "stop">;
}
