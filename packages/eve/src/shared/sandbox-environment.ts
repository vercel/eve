import { ContextContainer, contextStorage, type AlsContext } from "#context/container.js";
import type { SessionAuth, SessionParent, SessionTurn } from "#context/keys.js";
import type { SandboxProviderRuntime } from "#sandbox/provider.js";
import type {
  RuntimeSandboxSession,
  RuntimeSandboxSessionFor,
  SandboxSession,
} from "#shared/sandbox-session.js";

const ENVIRONMENT = Symbol.for("eve.sandbox-environment");
const PROVIDER_RUNTIME = Symbol.for("eve.sandbox-provider-runtime");
const SELECTOR_ENVIRONMENT = Symbol.for("eve.sandbox-selector-environment");

export interface SandboxSelectorContext {
  readonly session: {
    readonly auth: SessionAuth;
    readonly id: string;
    readonly parent?: SessionParent;
    readonly turn: SessionTurn;
  };
}

export type SandboxSelector = (
  context: SandboxSelectorContext,
) => Promise<RuntimeSandboxSession> | RuntimeSandboxSession;

export type SandboxOpenArguments<Options> = Options extends undefined
  ? []
  : Record<never, never> extends Options
    ? [options?: Options]
    : [options: Options];

export interface SandboxEnvironmentIdentity {
  readonly [ENVIRONMENT]: true;
  /** A {@link SandboxProviderRuntime}, opaque so the public type does not carry core internals. */
  readonly [PROVIDER_RUNTIME]: unknown;
  readonly provider: string;
}

export interface SandboxEnvironment<
  Options extends object | undefined = object,
  Session extends SandboxSession = SandboxSession,
> extends SandboxEnvironmentIdentity {
  open(...args: SandboxOpenArguments<Options>): Promise<RuntimeSandboxSessionFor<Session>>;
}

interface ConstructorRuntime {
  open(input: {
    readonly environment: object;
    readonly options: object | undefined;
    readonly provider: SandboxProviderRuntime;
  }): Promise<RuntimeSandboxSession>;
}

const RUNTIMES = Symbol.for("eve.sandbox-constructor-runtimes");
const globals = globalThis as typeof globalThis & {
  [RUNTIMES]?: WeakMap<AlsContext, ConstructorRuntime>;
};
const runtimes = (globals[RUNTIMES] ??= new WeakMap<AlsContext, ConstructorRuntime>());

export function createSandboxEnvironment<
  Options extends object | undefined = object,
  Session extends SandboxSession = SandboxSession,
>(runtime: SandboxProviderRuntime): SandboxEnvironment<Options, Session> {
  const environment: SandboxEnvironment<Options, Session> = {
    [ENVIRONMENT]: true,
    [PROVIDER_RUNTIME]: runtime,
    provider: runtime.providerName,
    async open(...args: SandboxOpenArguments<Options>) {
      const options = args[0] as object | undefined;
      const context = contextStorage.getStore();
      const opener = context === undefined ? undefined : runtimes.get(context);
      if (opener === undefined) {
        throw new Error(
          "Sandbox environments can only open sandboxes inside defineSandbox(). " +
            "Use `ctx.getSandbox()` to reach the session's sandbox from tools and other runtime code.",
        );
      }
      return (await opener.open({
        environment,
        options,
        provider: runtime,
      })) as RuntimeSandboxSessionFor<Session>;
    },
  };
  return environment;
}

export function getSandboxEnvironmentRuntime(
  environment: SandboxEnvironmentIdentity,
): SandboxProviderRuntime {
  return environment[PROVIDER_RUNTIME] as SandboxProviderRuntime;
}

export function bindSandboxEnvironment(
  selector: SandboxSelector,
  environment: SandboxEnvironmentIdentity,
): SandboxSelector {
  Object.defineProperty(selector, SELECTOR_ENVIRONMENT, { value: environment });
  return selector;
}

export function getBoundSandboxEnvironment(value: unknown): SandboxEnvironmentIdentity | undefined {
  const environment =
    typeof value === "function" ? Reflect.get(value, SELECTOR_ENVIRONMENT) : undefined;
  return isSandboxEnvironment(environment) ? environment : undefined;
}

export function isSandboxEnvironment(value: unknown): value is SandboxEnvironmentIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, ENVIRONMENT) === true &&
    typeof Reflect.get(value, "provider") === "string" &&
    typeof Reflect.get(value, "open") === "function"
  );
}

export async function runWithSandboxConstructorRuntime<T>(
  runtime: ConstructorRuntime,
  callback: () => Promise<T> | T,
): Promise<T> {
  const existing = contextStorage.getStore();
  const context = existing ?? new ContextContainer();
  const previous = runtimes.get(context);
  runtimes.set(context, runtime);
  try {
    return existing === undefined ? await contextStorage.run(context, callback) : await callback();
  } finally {
    if (previous === undefined) runtimes.delete(context);
    else runtimes.set(context, previous);
  }
}
