import { createHash } from "node:crypto";

import { ContextContainer, contextStorage, type AlsContext } from "#context/container.js";
import type { SessionAuth, SessionParent, SessionTurn } from "#context/keys.js";
import type { SandboxProviderRuntime } from "#shared/sandbox-provider.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";

const ENVIRONMENT = Symbol.for("eve.sandbox-environment");
const PROVIDER_RUNTIME = Symbol.for("eve.sandbox-provider-runtime");
const CONFIGURATION_HASH = Symbol.for("eve.sandbox-environment-configuration-hash");
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

export type SandboxNamedOptions<Options> = Options extends undefined
  ? { readonly name: string }
  : Options & { readonly name: string };

export type SandboxCreateArguments<Options> = Options extends undefined
  ? []
  : Record<never, never> extends Options
    ? [options?: Options]
    : [options: Options];

export interface SandboxEnvironmentIdentity {
  readonly [CONFIGURATION_HASH]: string;
  readonly [ENVIRONMENT]: true;
  readonly [PROVIDER_RUNTIME]: SandboxProviderRuntime;
  readonly kind: "default" | "dockerfile" | "image" | "prepared";
  readonly provider: string;
}

export interface SandboxEnvironment<Options = object> extends SandboxEnvironmentIdentity {
  create(...args: SandboxCreateArguments<Options>): Promise<RuntimeSandboxSession>;
  getOrCreate(options: SandboxNamedOptions<Options>): Promise<RuntimeSandboxSession>;
}

interface ConstructorRuntime {
  open(input: {
    readonly configurationHash: string;
    readonly environment: object;
    readonly environmentConfigurationHash: string;
    readonly name?: string;
    readonly options: object | undefined;
    readonly provider: SandboxProviderRuntime;
    readonly shared: boolean;
  }): Promise<RuntimeSandboxSession>;
}

const RUNTIMES = Symbol.for("eve.sandbox-constructor-runtimes");
const globals = globalThis as typeof globalThis & {
  [RUNTIMES]?: WeakMap<AlsContext, ConstructorRuntime>;
};
const runtimes = (globals[RUNTIMES] ??= new WeakMap<AlsContext, ConstructorRuntime>());

export function createSandboxEnvironment<Options = object>(input: {
  readonly configuration?: unknown;
  readonly kind?: SandboxEnvironment["kind"];
  readonly runtime: SandboxProviderRuntime;
}): SandboxEnvironment<Options> {
  let environment: SandboxEnvironment<Options>;

  async function open(options: Options, name: string | undefined, shared: boolean) {
    const context = contextStorage.getStore();
    const runtime = context === undefined ? undefined : runtimes.get(context);
    if (runtime === undefined) {
      throw new Error("Sandbox environments can only create sandboxes inside defineSandbox().");
    }
    return await runtime.open({
      configurationHash: hashConstructorOptions({
        environment: input.configuration,
        sandbox: options,
      }),
      environment,
      environmentConfigurationHash: environment[CONFIGURATION_HASH],
      name,
      options: options as object | undefined,
      provider: input.runtime,
      shared,
    });
  }

  environment = {
    [CONFIGURATION_HASH]: hashConstructorOptions({ environment: input.configuration, sandbox: {} }),
    [ENVIRONMENT]: true,
    [PROVIDER_RUNTIME]: input.runtime,
    kind: input.kind ?? "default",
    provider: input.runtime.providerName,
    async create(...args: SandboxCreateArguments<Options>) {
      return await open((args[0] ?? {}) as Options, undefined, false);
    },
    async getOrCreate(namedOptions: SandboxNamedOptions<Options>) {
      const { name, ...options } = namedOptions as { readonly name: string } & Record<
        string,
        unknown
      >;
      if (name.trim().length === 0) {
        throw new Error("Sandbox environment names must be non-empty.");
      }
      return await open(options as Options, name, true);
    },
  };
  return environment;
}

function hashConstructorOptions(options: unknown): string {
  return createHash("sha256").update(stableSerialize(options)).digest("hex");
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "function") return `function:${value.toString()}`;
  if (Array.isArray(value))
    return `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`;
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const constructorName = value.constructor?.name ?? "Object";
    const serialized = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry, seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return `${constructorName}:${serialized}`;
  }
  return typeof value;
}

export type SandboxPrepare = (sandbox: SandboxSession) => Promise<void> | void;

export function getSandboxEnvironmentConfigurationHash(
  environment: SandboxEnvironmentIdentity,
): string {
  return environment[CONFIGURATION_HASH];
}

export function getSandboxEnvironmentRuntime(
  environment: SandboxEnvironmentIdentity,
): SandboxProviderRuntime {
  return environment[PROVIDER_RUNTIME];
}

export function getSandboxEnvironmentPreparation(
  environment: SandboxEnvironmentIdentity,
): SandboxPrepare | undefined {
  return environment[PROVIDER_RUNTIME].prepare;
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
  return typeof value === "object" && value !== null && Reflect.get(value, ENVIRONMENT) === true;
}

export async function runWithSandboxConstructorRuntime<T>(
  runtime: ConstructorRuntime,
  callback: () => Promise<T>,
): Promise<T> {
  const active = contextStorage.getStore();
  const context = active ?? new ContextContainer();
  const previous = runtimes.get(context);
  runtimes.set(context, runtime);
  try {
    return await (active === undefined ? contextStorage.run(context, callback) : callback());
  } finally {
    if (previous === undefined) runtimes.delete(context);
    else runtimes.set(context, previous);
  }
}
