import { contextStorage, type AlsContext } from "#context/container.js";
import { createSandboxHandleScope } from "#execution/sandbox/handle-scope.js";
import { createSandboxTemplateBindingScope } from "#execution/sandbox/template-bindings.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import {
  createRuntimeSandboxDefinitionRevision,
  createRuntimeSandboxSessionKey,
} from "#runtime/sandbox/keys.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxAccess, SandboxState, SandboxStateValue } from "#sandbox/state.js";
import {
  getSandboxResourceId,
  isSandbox,
  withSandboxProviderContext,
  type Sandbox,
} from "#shared/sandbox-value.js";

export interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly context: AlsContext;
  readonly nodeId: string;
  readonly parentState?: SandboxStateValue;
  readonly registry: RuntimeSandboxRegistry;
  readonly rootState?: SandboxStateValue;
  readonly signal?: AbortSignal;
  readonly session: SessionContext["session"];
  readonly sessionId: string;
  readonly state: SandboxState | null;
  readonly tags?: Readonly<Record<string, string>>;
}

export async function ensureSandboxAccess(input: EnsureSandboxAccessInput): Promise<SandboxAccess> {
  const registered = input.registry.sandbox;
  if (registered === null) {
    return emptySandboxAccess();
  }
  const definition = registered.definition;

  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const signal = input.signal ?? new AbortController().signal;
  const revision = await createRuntimeSandboxDefinitionRevision({
    nodeId: input.nodeId,
    sourceHash: definition.sourceHash,
    sourceId: definition.sourceId,
    workspaceResourceRoot: registered.workspaceResourceRoot,
  });
  const resourceId = await createRuntimeSandboxSessionKey({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
    revision,
    sessionId: input.sessionId,
  });
  const templates = await createSandboxTemplateBindingScope({
    appRoot,
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
    revision,
    sandbox: registered,
  });
  const handles = createSandboxHandleScope({ appRoot, signal });
  let persistedState =
    input.state !== null && input.state.revision === revision ? input.state : null;
  // Unused sandboxes must not allocate provider compute.
  let sandboxPromise: Promise<Sandbox> | undefined;

  function getSandbox(): Promise<Sandbox> {
    sandboxPromise ??= createOrRestoreSandbox().catch((error) => {
      sandboxPromise = undefined;
      throw error;
    });
    return sandboxPromise;
  }

  async function createOrRestoreSandbox(): Promise<Sandbox> {
    if (persistedState !== null) {
      return handles.restoreCurrent(persistedState.value, input.tags);
    }

    return await contextStorage.run(
      input.context,
      async () => await templates.run(invokeDefinition),
    );
  }

  async function invokeDefinition(): Promise<Sandbox> {
    const value = await withSandboxProviderContext(
      {
        appRoot,
        resourceId,
        signal,
        tags: input.tags,
      },
      async () =>
        await definition.definition({
          parent:
            input.parentState === undefined
              ? null
              : { sandbox: Promise.resolve(handles.restoreAncestor(input.parentState)) },
          root:
            input.rootState === undefined
              ? null
              : { sandbox: Promise.resolve(handles.restoreAncestor(input.rootState)) },
          runtime: {
            mode: isEveDevEnvironment() ? "development" : "production",
          },
          session: input.session,
          signal,
        }),
      { onCreate: handles.track },
    );
    const sandbox = expectDurableSandbox(value, definition.logicalPath);
    handles.track(sandbox);
    return sandbox;
  }

  return {
    async captureState() {
      if (sandboxPromise === undefined) {
        return persistedState;
      }
      const value = await handles.capture(await sandboxPromise);
      const state: SandboxState =
        input.rootState === undefined
          ? { revision, value }
          : { revision, root: input.rootState, value };
      persistedState = state;
      return state;
    },
    async get() {
      return await getSandbox();
    },
  };
}

function expectDurableSandbox(value: unknown, logicalPath: string): Sandbox {
  if (!isSandbox(value)) {
    throw new TypeError(`Sandbox definition "${logicalPath}" must return a durable Sandbox value.`);
  }
  getSandboxResourceId(value);
  return value;
}

function emptySandboxAccess(): SandboxAccess {
  return {
    async captureState() {
      return null;
    },
    async get() {
      return null;
    },
  };
}
