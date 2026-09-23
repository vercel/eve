import type { SessionContext } from "#context/session-context.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";
import { loadContext } from "#context/container.js";
import { DynamicSkillSandboxKey, SandboxKey, SessionKey } from "#context/keys.js";

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
            // A recreated sandbox can reuse the same persisted identity.
            ctx.delete(DynamicSkillSandboxKey);
          },
          async () => await access.stop(),
        );
      });
    },
  };
}

export function withRuntimeSandboxLifecycle<Session extends SandboxSession>(
  sandbox: Session,
  deleteSandbox: RuntimeSandboxSession["delete"],
  stop: () => Promise<void>,
): Session & Pick<RuntimeSandboxSession, "delete" | "stop"> {
  return new Proxy(Object.create(null) as object, {
    get(_proxyTarget, property) {
      if (property === "delete") return deleteSandbox;
      if (property === "stop") return stop;
      const value = Reflect.get(sandbox, property, sandbox);
      return typeof value === "function" ? value.bind(sandbox) : value;
    },
    getOwnPropertyDescriptor(_proxyTarget, property) {
      if (property === "delete" || property === "stop") {
        return { configurable: true, enumerable: true, writable: false };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(sandbox, property);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    has(_proxyTarget, property) {
      return property === "delete" || property === "stop" || Reflect.has(sandbox, property);
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(sandbox), "delete", "stop"])];
    },
  }) as Session & Pick<RuntimeSandboxSession, "delete" | "stop">;
}
