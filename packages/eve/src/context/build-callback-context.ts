import type { SessionContext } from "#public/definitions/callback-context.js";
import type { SkillHandle } from "#execution/skills/types.js";
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
        return withRuntimeSandboxStop(sandbox, async () => await access.stop());
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

function withRuntimeSandboxStop(
  sandbox: SandboxSession,
  stop: () => Promise<void>,
): RuntimeSandboxSession {
  return {
    id: sandbox.id,
    readBinaryFile: (options) => sandbox.readBinaryFile(options),
    readFile: (options) => sandbox.readFile(options),
    readTextFile: (options) => sandbox.readTextFile(options),
    removePath: (options) => sandbox.removePath(options),
    resolvePath: (path) => sandbox.resolvePath(path),
    run: (options) => sandbox.run(options),
    setNetworkPolicy: (policy) => sandbox.setNetworkPolicy(policy),
    spawn: (options) => sandbox.spawn(options),
    stop,
    writeBinaryFile: (options) => sandbox.writeBinaryFile(options),
    writeFile: (options) => sandbox.writeFile(options),
    writeTextFile: (options) => sandbox.writeTextFile(options),
  };
}
