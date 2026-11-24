import type { GetSandboxOptions, SessionContext } from "#context/session-context.js";
import {
  isSandboxEnvironment,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import { loadContext } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { SandboxKey, SessionKey } from "#context/keys.js";
import { ConversationContextKey } from "#shared/conversation-context.js";

export function buildCallbackContext(): SessionContext {
  const ctx = loadContext();
  const session = ctx.require(SessionKey);
  const conversation = ctx.get(ConversationContextKey);

  return {
    session: {
      id: session.sessionId,
      auth: session.auth,
      turn: session.turn,
      parent: session.parent,
      schedule: readSessionSchedule(ctx),
      predecessor: session.predecessor,
    },
    ...(conversation !== undefined && { conversation }),

    getSandbox: sandboxOf(ctx),
  };
}

export function parseGetSandboxArgs(
  first?: SandboxEnvironmentIdentity | GetSandboxOptions,
  second?: GetSandboxOptions,
): {
  readonly environment?: SandboxEnvironmentIdentity;
  readonly options?: GetSandboxOptions;
} {
  if (first === undefined) return { options: second };
  if (isSandboxEnvironment(first)) return { environment: first, options: second };
  return { options: first };
}

export function sandboxOf(ctx: Pick<ContextReader, "get">): SessionContext["getSandbox"] {
  return ((
    first?: SandboxEnvironmentIdentity | GetSandboxOptions,
    second?: GetSandboxOptions,
  ): Promise<RuntimeSandboxSession | null> => {
    const { environment, options } = parseGetSandboxArgs(first, second);
    const access = ctx.get(SandboxKey);
    if (access === undefined) {
      throw new Error(
        "eve sandbox runtime access is unavailable in the current async context. " +
          "Call ctx.getSandbox() only from authored runtime functions such as tools, hooks, dynamic values, and channel events.",
      );
    }
    if (environment !== undefined && access.environment !== environment) {
      throw new Error("The requested sandbox environment is not active for the current session.");
    }
    const ifStarted = options?.ifStarted === true;
    const resolve = ifStarted ? access.getIfStarted() : access.get();
    return resolve.then((sandbox) => {
      if (sandbox === null) {
        if (ifStarted) return null;
        throw new Error("The sandbox is not available in the current authored runtime context.");
      }
      return withRuntimeSandboxLifecycle(
        sandbox,
        async (deleteOptions) => {
          if (access.delete === undefined) {
            throw new Error("The active sandbox runtime does not support deletion.");
          }
          await access.delete(deleteOptions);
        },
        async () => await access.stop(),
      );
    });
  }) as SessionContext["getSandbox"];
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
