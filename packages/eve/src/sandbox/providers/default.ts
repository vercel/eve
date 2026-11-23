import { isLinuxDockerDaemonAvailableSync } from "#execution/sandbox/bindings/local.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { appOf } from "#context/app.js";
import { contextStorage } from "#context/container.js";
import { hostedSandboxEnvironment, hostedSandboxOf } from "#platform/hosted-sandbox.js";
import type { DockerSandboxEnvironmentOptions } from "#public/sandbox/docker-sandbox.js";
import type { SandboxSession } from "#public/sandbox/index.js";
import {
  defineSandboxProvider,
  SandboxSessionGoneError,
  type SandboxConnection,
  type SandboxIdleTimeoutOption,
  type SandboxJson,
  type SandboxProvider,
  type SandboxProviderImplementation,
} from "#public/sandbox/provider.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import { withAdoptedSandboxSessionStates, withRecordedSandboxProvider } from "#sandbox/state.js";
import { DockerSandbox } from "#sandbox/providers/docker.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { isObject } from "#shared/guards.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type {
  SandboxNetworkOptions,
  SandboxNetworkPolicy,
} from "#shared/sandbox-network-policy.js";
import { ToolSessionSandboxUnsupportedError } from "#shared/sandbox-tool-session-error.js";

/**
 * Options for a `DefaultSandbox` environment: a shared `prepare` and `idleTimeoutMs`, plus
 * per-provider options for Vercel Sandbox, Docker, and just-bash, applied to whichever provider
 * is selected.
 */
export interface DefaultSandboxEnvironmentOptions extends SandboxIdleTimeoutOption {
  readonly docker?: Omit<DockerSandboxEnvironmentOptions, "idleTimeoutMs">;
  readonly justBash?: {
    readonly autoInstall?: boolean;
    readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
  };
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
  readonly vercel?: VercelSandboxCreateOptions;
}

/** Options applied when eve creates one live sandbox from a `DefaultSandbox` environment. */
export type DefaultSandboxRuntimeOptions = SandboxNetworkOptions;

/** Live sandbox capabilities exposed by a `DefaultSandbox` environment. */
export interface DefaultSandboxSession extends SandboxSession {
  /**
   * Applies a network policy to the live sandbox. Docker accepts only
   * `"allow-all"` and `"deny-all"`; just-bash accepts only `"allow-all"`.
   */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

type SelectedProvider = string;

type DefaultSandboxPreparedArtifact =
  | { readonly artifact: SandboxJson; readonly provider: SelectedProvider }
  | { readonly provider: null };

type DefaultSandboxSessionState = {
  readonly provider: SelectedProvider;
  readonly state: SandboxJson;
  readonly stateProtocolVersion: number;
};

type NetworkPolicyExtensions = Pick<DefaultSandboxSession, "setNetworkPolicy">;

const NO_PROVIDER_MESSAGE =
  "DefaultSandbox has no sandbox provider for this build: it did not run on Vercel, no Docker " +
  "daemon was reachable, and production builds do not fall back to just-bash. Start Docker " +
  "and rebuild, deploy to Vercel, or select a provider explicitly in your sandbox module, such " +
  "as agent/sandbox/sandbox.ts.";

const JUST_BASH_NETWORK_POLICY_MESSAGE =
  'DefaultSandbox selected just-bash, which always allows network access and accepts only the "allow-all" ' +
  "network policy. Start Docker so DefaultSandbox selects it, or select VercelSandbox or " +
  "DockerSandbox explicitly.";

/**
 * Selects Vercel Sandbox on Vercel, Docker when a daemon is reachable, and
 * just-bash in development. Preparation records the choice, so the runtime
 * uses the provider the build selected and never probes the host.
 */
export const DefaultSandbox: SandboxProvider<
  DefaultSandboxEnvironmentOptions,
  DefaultSandboxRuntimeOptions,
  DefaultSandboxSession
> = defineSandboxProvider({
  name: "default",
  environment(options: Omit<DefaultSandboxEnvironmentOptions, "prepare">) {
    if (
      options.justBash &&
      Object.keys(options.justBash).some((key) => key !== "autoInstall" && key !== "prepare")
    ) {
      throw new Error(
        "DefaultSandbox justBash settings support autoInstall and prepare only. Use JustBashSandbox.environment({ experimental }) for customCommands or filesystem.",
      );
    }
    const providers = new Map<SelectedProvider, ReturnType<typeof getSandboxEnvironmentRuntime>>();
    const provider = (name: SelectedProvider) => {
      let runtime = providers.get(name);
      if (runtime === undefined) {
        runtime = getSandboxEnvironmentRuntime(createEnvironment(name, options));
        providers.set(name, runtime);
      }
      return runtime;
    };

    function requireProvider(name: SelectedProvider, kind: "session" | "tool-session") {
      const inner = provider(name);
      if (kind === "tool-session" && inner.implementation.toolSessions !== true) {
        throw new ToolSessionSandboxUnsupportedError(name);
      }
      return inner;
    }

    function recordedProvider(state: SandboxJson | null, artifact: SandboxJson | undefined) {
      const recorded = isDefaultSandboxSessionState(state) ? state : null;
      const name =
        recorded?.provider ??
        (isDefaultSandboxPreparedArtifact(artifact) ? artifact.provider : null);
      if (name === null) return undefined;
      const inner = provider(name);
      const innerState =
        recorded?.stateProtocolVersion === inner.stateProtocolVersion ? recorded.state : null;
      return { implementation: inner.implementation, state: innerState };
    }

    const implementation: SandboxProviderImplementation<
      DefaultSandboxRuntimeOptions,
      DefaultSandboxPreparedArtifact,
      DefaultSandboxSessionState,
      NetworkPolicyExtensions
    > = {
      async onSessionEnd(context, state, endOptions) {
        const inner = recordedProvider(state, undefined);
        await inner?.implementation.onSessionEnd(context, inner.state, endOptions);
      },
      async onSessionIdle(context, state, idleOptions) {
        const inner = recordedProvider(state, undefined);
        await inner?.implementation.onSessionIdle?.(context, inner.state, idleOptions);
      },
      async prepare(context) {
        const name = selectProvider();
        if (name === null) {
          context.log(NO_PROVIDER_MESSAGE);
          return { provider: null };
        }
        return { artifact: await provider(name).implementation.prepare(context), provider: name };
      },
      async start(context, openOptions, artifact) {
        if (artifact.provider === null) throw new Error(NO_PROVIDER_MESSAGE);
        const inner = requireProvider(artifact.provider, context.kind);
        const result = await inner.implementation.start(
          context,
          innerOpenOptions(artifact.provider, openOptions),
          artifact.artifact,
        );
        return {
          connection: withNetworkPolicy(result.connection),
          state: {
            provider: artifact.provider,
            state: result.state,
            stateProtocolVersion: inner.stateProtocolVersion,
          },
        };
      },
      async resume(context, artifact, state) {
        if (artifact.provider === null || artifact.provider !== state.provider) {
          throw new SandboxSessionGoneError(
            `The session's ${state.provider} sandbox cannot resume because this build selected ${artifact.provider ?? "no provider"}.`,
          );
        }
        const inner = requireProvider(state.provider, context.kind);
        if (state.stateProtocolVersion !== inner.stateProtocolVersion) {
          throw new SandboxSessionGoneError(
            `The session's ${state.provider} sandbox state uses protocol ${state.stateProtocolVersion}, not ${inner.stateProtocolVersion}.`,
          );
        }
        return withNetworkPolicy(
          await inner.implementation.resume(context, artifact.artifact, state.state),
        );
      },
      toolSessions: true,
    };

    withRecordedSandboxProvider(implementation, recordedProvider);
    return withAdoptedSandboxSessionStates(implementation, (record) => {
      const name = record.providerName;
      if (!isSelectedProvider(name)) return undefined;
      return {
        provider: name,
        state: record.state,
        stateProtocolVersion: record.stateProtocolVersion,
      };
    });
  },
});

function turnPlatform() {
  return appOf(contextStorage.getStore())?.platform;
}

function selectProvider(): SelectedProvider | null {
  const hosted = hostedSandboxOf(turnPlatform());
  if (hosted?.selectByDefault) return hosted.name;
  if (isLinuxDockerDaemonAvailableSync()) return "docker";
  return isEveDevEnvironment() ? "just-bash" : null;
}

function createEnvironment(
  name: SelectedProvider,
  options: Omit<DefaultSandboxEnvironmentOptions, "prepare">,
) {
  switch (name) {
    case "docker":
      return DockerSandbox.environment(options.docker ?? {});
    case "just-bash":
      return JustBashSandbox.environment(options.justBash ?? {});
    default:
      return hostedSandboxEnvironment(turnPlatform(), options.vercel ?? {});
  }
}

function innerOpenOptions(
  name: SelectedProvider,
  options: Readonly<DefaultSandboxRuntimeOptions> | undefined,
): Readonly<DefaultSandboxRuntimeOptions> | undefined {
  if (name !== "just-bash") return options;
  if (options?.networkPolicy !== undefined && options.networkPolicy !== "allow-all") {
    throw new Error(JUST_BASH_NETWORK_POLICY_MESSAGE);
  }
  return undefined;
}

function withNetworkPolicy(connection: SandboxConnection<object>) {
  const extensions: object = connection.extensions ?? {};
  if (typeof Reflect.get(extensions, "setNetworkPolicy") === "function") {
    return connection as SandboxConnection<NetworkPolicyExtensions>;
  }
  return {
    ...connection,
    extensions: { ...extensions, setNetworkPolicy: rejectJustBashNetworkPolicy },
  } as SandboxConnection<NetworkPolicyExtensions>;
}

async function rejectJustBashNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
  if (policy !== "allow-all") throw new Error(JUST_BASH_NETWORK_POLICY_MESSAGE);
}

function isSelectedProvider(value: unknown): value is SelectedProvider {
  return (
    value === "docker" ||
    value === "just-bash" ||
    (typeof value === "string" && value === hostedSandboxOf(turnPlatform())?.name)
  );
}

function isDefaultSandboxSessionState(
  value: SandboxJson | null,
): value is DefaultSandboxSessionState {
  return (
    isObject(value) &&
    isSelectedProvider(value.provider) &&
    typeof value.stateProtocolVersion === "number" &&
    "state" in value
  );
}

function isDefaultSandboxPreparedArtifact(
  value: SandboxJson | undefined,
): value is DefaultSandboxPreparedArtifact {
  return (
    isObject(value) &&
    (value.provider === null || (isSelectedProvider(value.provider) && "artifact" in value))
  );
}
