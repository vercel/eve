import { isLinuxDockerDaemonAvailableSync } from "#execution/sandbox/bindings/local.js";
import { isToolSessionId } from "#execution/tool-session/id.js";
import {
  getToolSessionSandboxSupport,
  ToolSessionSandboxUnsupportedError,
  withToolSessionSandboxes,
} from "#execution/tool-session/sandbox.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { DockerSandboxEnvironmentOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import {
  type SandboxSessionEndWithArtifact,
  withAdoptedSandboxSessionStates,
  withSessionEndArtifact,
} from "#sandbox/state.js";
import { DockerSandbox } from "#sandbox/providers/docker.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type {
  SandboxNetworkOptions,
  SandboxNetworkPolicy,
} from "#shared/sandbox-network-policy.js";
import {
  defineLegacySandboxProvider,
  isSandboxPreparedArtifactRecord,
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type LegacySandboxProviderImplementation,
  type SandboxProviderRuntime,
} from "#shared/sandbox-provider.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface DefaultSandboxEnvironmentOptions {
  readonly docker?: DockerSandboxEnvironmentOptions;
  readonly justBash?: JustBashSandboxCreateOptions;
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

type SelectedProvider = "docker" | "just-bash" | "vercel";

type DefaultSandboxPreparedArtifact =
  | { readonly artifact: SandboxPreparedArtifact; readonly provider: SelectedProvider }
  | { readonly provider: null };

type DefaultSandboxSessionState = {
  readonly provider: SelectedProvider;
  readonly state: SandboxPreparedArtifact;
  /** The selected provider's state protocol when it recorded `state`. */
  readonly stateProtocolVersion: number;
};

const SELECTED_PROVIDERS: readonly SelectedProvider[] = ["docker", "just-bash", "vercel"];

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
export const DefaultSandbox = defineLegacySandboxProvider<
  DefaultSandboxEnvironmentOptions,
  DefaultSandboxRuntimeOptions,
  DefaultSandboxPreparedArtifact,
  DefaultSandboxSessionState,
  DefaultSandboxSession
>({
  name: "default",
  environment(options = {}) {
    // Created on first use, so a hosted bundle never constructs the local providers it prunes.
    const providers = new Map<SelectedProvider, SandboxProviderRuntime>();
    const provider = (name: SelectedProvider) => {
      let runtime = providers.get(name);
      if (runtime === undefined) {
        runtime = getSandboxEnvironmentRuntime(createEnvironment(name, options));
        providers.set(name, runtime);
      }
      return runtime;
    };
    const releases = new WeakMap<SandboxProviderHandle, () => Promise<void>>();

    function wrapHandle(
      inner: SandboxProviderRuntime,
      handle: SandboxProviderHandle,
    ): SandboxProviderHandle<DefaultSandboxSession> {
      const wrapped: SandboxProviderHandle<DefaultSandboxSession> = {
        sandbox: hasNetworkPolicy(handle.sandbox)
          ? handle.sandbox
          : { ...handle.sandbox, setNetworkPolicy: rejectJustBashNetworkPolicy },
        onRuntimeShutdown: () => handle.onRuntimeShutdown(),
        onSandboxDelete: (deleteOptions) => handle.onSandboxDelete(deleteOptions),
        onSandboxStop: () => handle.onSandboxStop(),
      };
      const release = getToolSessionSandboxSupport(inner.implementation)?.releaseHandle;
      if (release !== undefined) releases.set(wrapped, () => release(handle));
      return wrapped;
    }

    function requireProvider(name: SelectedProvider, sessionId: string) {
      const inner = provider(name);
      if (
        isToolSessionId(sessionId) &&
        getToolSessionSandboxSupport(inner.implementation) === undefined
      ) {
        throw new ToolSessionSandboxUnsupportedError(name);
      }
      return inner;
    }

    // Routes to the provider that recorded the state, or else the one this build selected.
    const endSession = async (
      context: Parameters<SandboxSessionEndWithArtifact>[0],
      state: Readonly<DefaultSandboxSessionState> | null,
      options: {
        readonly artifact: DefaultSandboxPreparedArtifact | undefined;
        readonly reason: Parameters<SandboxSessionEndWithArtifact>[2]["reason"];
      },
    ) => {
      const name = state?.provider ?? options.artifact?.provider ?? null;
      if (name === null) return;
      const inner = provider(name);
      const innerState =
        state?.stateProtocolVersion === inner.stateProtocolVersion ? state.state : null;
      await inner.implementation.onSessionEnd(context, innerState, { reason: options.reason });
    };

    const implementation: LegacySandboxProviderImplementation<
      DefaultSandboxRuntimeOptions,
      DefaultSandboxPreparedArtifact,
      DefaultSandboxSessionState,
      DefaultSandboxSession
    > = {
      async onSessionEnd(context, state, { reason }) {
        await endSession(context, state, { artifact: undefined, reason });
      },
      async prepare(context) {
        const name = selectProvider();
        if (name === null) {
          context.log?.(NO_PROVIDER_MESSAGE);
          return { provider: null };
        }
        return { artifact: await provider(name).implementation.prepare(context), provider: name };
      },
      async resume(context, artifact, state) {
        if (artifact.provider === null || artifact.provider !== state.provider) {
          throw new SandboxSessionGoneError(
            `The session's ${state.provider} sandbox cannot resume because this build selected ${artifact.provider ?? "no provider"}.`,
          );
        }
        const inner = requireProvider(state.provider, context.session.id);
        if (state.stateProtocolVersion !== inner.stateProtocolVersion) {
          throw new SandboxSessionGoneError(
            `The session's ${state.provider} sandbox state uses protocol ${state.stateProtocolVersion}, not ${inner.stateProtocolVersion}.`,
          );
        }
        const handle = await inner.implementation.resume(context, artifact.artifact, state.state);
        return wrapHandle(inner, handle);
      },
      async start(context, options, artifact) {
        if (artifact.provider === null) throw new Error(NO_PROVIDER_MESSAGE);
        const inner = requireProvider(artifact.provider, context.session.id);
        const result = await inner.implementation.start(
          context,
          openOptions(artifact.provider, options),
          artifact.artifact,
        );
        return {
          handle: wrapHandle(inner, result.handle),
          state: {
            provider: artifact.provider,
            state: result.state,
            stateProtocolVersion: inner.stateProtocolVersion,
          },
        };
      },
    };

    withToolSessionSandboxes(implementation, {
      releaseHandle: async (handle) => await releases.get(handle)?.(),
    });
    withSessionEndArtifact(implementation, async (context, state, options) => {
      await endSession(context, isDefaultSandboxSessionState(state) ? state : null, {
        artifact: isDefaultSandboxPreparedArtifact(options.artifact) ? options.artifact : undefined,
        reason: options.reason,
      });
    });
    // Sessions saved before DefaultSandbox recorded its own state hold the state
    // of the provider it picked. Remove this once eve stops resuming sessions
    // saved by releases before it, at the next sandbox state reset like eve 0.64's.
    // `resume` treats a protocol the inner provider no longer speaks as gone.
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

function selectProvider(): SelectedProvider | null {
  if (process.env.VERCEL?.trim()) return "vercel";
  if (isLinuxDockerDaemonAvailableSync()) return "docker";
  return isEveDevEnvironment() ? "just-bash" : null;
}

function createEnvironment(name: SelectedProvider, options: DefaultSandboxEnvironmentOptions) {
  const prepare = options.prepare === undefined ? {} : { prepare: options.prepare };
  switch (name) {
    case "docker":
      return DockerSandbox.environment({ ...options.docker, ...prepare });
    case "just-bash":
      return JustBashSandbox.environment({ ...options.justBash, ...prepare });
    case "vercel":
      return VercelSandbox.environment({ ...options.vercel, ...prepare });
  }
}

function openOptions(
  name: SelectedProvider,
  options: Readonly<DefaultSandboxRuntimeOptions> | undefined,
): Readonly<DefaultSandboxRuntimeOptions> | undefined {
  if (name !== "just-bash") return options;
  if (options?.networkPolicy !== undefined && options.networkPolicy !== "allow-all") {
    throw new Error(JUST_BASH_NETWORK_POLICY_MESSAGE);
  }
  return undefined;
}

async function rejectJustBashNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
  if (policy !== "allow-all") throw new Error(JUST_BASH_NETWORK_POLICY_MESSAGE);
}

function hasNetworkPolicy(session: SandboxSession): session is DefaultSandboxSession {
  return typeof Reflect.get(session, "setNetworkPolicy") === "function";
}

function isSelectedProvider(value: unknown): value is SelectedProvider {
  return SELECTED_PROVIDERS.some((name) => name === value);
}

function isDefaultSandboxSessionState(
  value: SandboxPreparedArtifact | null,
): value is DefaultSandboxSessionState {
  return (
    isSandboxPreparedArtifactRecord(value) &&
    isSelectedProvider(value.provider) &&
    typeof value.stateProtocolVersion === "number" &&
    "state" in value
  );
}

function isDefaultSandboxPreparedArtifact(
  value: SandboxPreparedArtifact | undefined,
): value is DefaultSandboxPreparedArtifact {
  return (
    isSandboxPreparedArtifactRecord(value) &&
    (value.provider === null || (isSelectedProvider(value.provider) && "artifact" in value))
  );
}
