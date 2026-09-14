import { contextStorage } from "#context/container.js";
import {
  buildCallbackContext,
  withRuntimeSandboxLifecycle,
} from "#context/build-callback-context.js";
import { trackActiveSandboxHandle } from "#execution/sandbox/active-handles.js";
import { waitForDevelopmentSandboxPrewarm } from "#execution/sandbox/development-prewarm.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { waitForSandboxTemplatePrewarmLock } from "#execution/sandbox/template-prewarm-lock.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { createRuntimeSandboxKeys } from "#runtime/sandbox/keys.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import type { SandboxAccess, SandboxSessionState, SandboxState } from "#sandbox/state.js";
import {
  getSandboxEnvironmentConfigurationHash,
  getSandboxEnvironmentRuntime,
  runWithSandboxConstructorRuntime,
} from "#shared/sandbox-environment.js";
import {
  createSandboxProviderResources,
  type SandboxDeleteOptions,
  type SandboxProviderHandle,
  type SandboxProviderPreparedArtifact,
  type SandboxProviderRuntime,
  type SandboxProviderTags,
} from "#shared/sandbox-provider.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";

export interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly ownsSandbox?: boolean;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly state: SandboxState | null;
  readonly tags?: SandboxProviderTags;
}

type RuntimeProviderHandle = SandboxProviderHandle<Record<string, unknown>>;

export async function ensureSandboxAccess(input: EnsureSandboxAccessInput): Promise<SandboxAccess> {
  let initialized = input.state?.initialized ?? false;
  let persisted: SandboxSessionState | null = input.state?.session ?? null;
  let handle: RuntimeProviderHandle | undefined;
  let openedConfigurationHash: string | undefined;
  let openedProviderName: string | undefined;
  let openedSandbox: RuntimeSandboxSession | undefined;
  let openedSessionKey: string | undefined;
  let opening: Promise<RuntimeProviderHandle> | undefined;
  let providerOwned = false;
  let requiring: Promise<RuntimeProviderHandle> | undefined;
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const registered = input.registry.sandbox;

  if (registered === null) {
    return {
      async captureState() {
        return { initialized, session: persisted };
      },
      async get() {
        return null;
      },
      async stop() {},
    };
  }

  async function open(
    provider: SandboxProviderRuntime,
    options: object | undefined,
    configurationHash: string,
    environment: object,
    environmentConfigurationHash: string,
    name?: string,
    shared = false,
  ): Promise<RuntimeSandboxSession> {
    if (opening !== undefined) throw new Error("A sandbox definition can create only one sandbox.");
    const inherited = registered.inheritance;
    const definition = inherited?.definition ?? registered.definition;
    if (definition.kind !== "independent")
      throw new Error(`Sandbox "${definition.logicalPath}" has no environment.`);
    if (environment !== definition.environment)
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different environment.`);
    if (provider !== getSandboxEnvironmentRuntime(definition.environment))
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different provider.`);

    const workspaceResourceRoot =
      inherited?.workspaceResourceRoot ?? registered.workspaceResourceRoot;
    const keys = await createRuntimeSandboxKeys({
      compiledArtifactsSource: input.compiledArtifactsSource,
      configurationHash,
      environmentConfigurationHash,
      nodeId: inherited?.nodeId ?? input.nodeId,
      providerName: provider.providerName,
      sessionId: name ?? input.sessionId,
      shared,
      sourceId: definition.sourceId,
      templatePlan: createRuntimeSandboxTemplatePlan({ definition, workspaceResourceRoot }),
    });

    if (keys.templateKey !== null) {
      const log = (message: string) =>
        logDevelopmentSandbox(
          `eve: sandbox template "${formatNodeLabel(input.nodeId)}" (${provider.providerName}): ${message}`,
        );
      await waitForDevelopmentSandboxPrewarm({
        appRoot,
        compiledArtifactsSource: input.compiledArtifactsSource,
        log,
      });
      await waitForSandboxTemplatePrewarmLock({
        appRoot,
        log,
        providerName: provider.providerName,
        templateKey: keys.templateKey,
      });
    }

    const existing =
      persisted?.providerName === provider.providerName && persisted.sessionKey === keys.sessionKey
        ? persisted
        : null;
    const sandboxName = keys.sessionKey;
    const create = async () => {
      const prepared = await resolveProviderPreparedArtifact({
        compiledArtifactsSource: input.compiledArtifactsSource,
        providerName: provider.providerName,
        templateName: keys.templateKey,
      });
      return await provider.implementation.getOrCreate(
        {
          appRoot,
          existing: existing?.metadata,
          handle: (providerHandle) => providerHandle,
          options,
          resources: createSandboxProviderResources({
            resourcesKey: workspaceResourceRoot.contentHash,
          }),
          sandboxName,
          tags: {
            ...input.tags,
            ...(shared ? { sandboxConfig: configurationHash.slice(0, 32) } : {}),
          },
        },
        prepared,
      );
    };

    opening = withDevelopmentSandboxProgress(
      `eve: opening sandbox session "${formatNodeLabel(input.nodeId)}" on provider "${provider.providerName}"...`,
      `eve: opening sandbox session "${formatNodeLabel(input.nodeId)}" on provider "${provider.providerName}"`,
      async () =>
        await getOrCreateWithRepair({
          appRoot,
          compiledArtifactsSource: input.compiledArtifactsSource,
          create,
          providerName: provider.providerName,
          templateName: keys.templateKey,
        }),
    ).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });

    const openedHandle = await opening;
    handle = openedHandle;
    providerOwned = shared;
    openedConfigurationHash = configurationHash;
    openedProviderName = provider.providerName;
    openedSessionKey = sandboxName;
    initialized = true;
    if (!shared) {
      trackActiveSandboxHandle({
        handle: openedHandle,
        providerName: provider.providerName,
        sessionKey: sandboxName,
      });
    }

    const remove = shared
      ? async () => {
          throw new Error("Named shared sandboxes have provider-owned lifetime.");
        }
      : (deleteOptions?: SandboxDeleteOptions) => openedHandle.delete(deleteOptions);
    openedSandbox = withRuntimeSandboxLifecycle(
      openedHandle.sandbox,
      remove,
      shared
        ? async () => {
            throw new Error("Named shared sandboxes cannot be stopped by one eve session.");
          }
        : () => openedHandle.stop(),
    );
    return openedSandbox;
  }

  function requireHandle(): Promise<RuntimeProviderHandle> {
    if (handle !== undefined) return Promise.resolve(handle);
    requiring ??= resolveHandle().catch((error: unknown) => {
      requiring = undefined;
      throw error;
    });
    return requiring;
  }

  async function resolveHandle(): Promise<RuntimeProviderHandle> {
    const inherited = registered.inheritance;
    const definition = inherited?.definition ?? registered.definition;
    if (definition.kind !== "independent") {
      throw new Error(`Sandbox "${definition.logicalPath}" has no resolved parent.`);
    }

    if (inherited !== undefined) {
      const configurationHash = getSandboxEnvironmentConfigurationHash(definition.environment);
      await open(
        getSandboxEnvironmentRuntime(definition.environment),
        undefined,
        configurationHash,
        definition.environment,
        configurationHash,
      );
    } else {
      const session =
        contextStorage.getStore() === undefined
          ? {
              auth: { current: null, initiator: null },
              id: input.sessionId,
              turn: { id: "sandbox-initialization", sequence: 0 },
            }
          : buildCallbackContext().session;
      try {
        const selected = await runWithSandboxConstructorRuntime(
          {
            open: ({
              configurationHash,
              environment,
              environmentConfigurationHash,
              name,
              options,
              provider,
              shared,
            }) =>
              open(
                provider,
                options,
                configurationHash,
                environment,
                environmentConfigurationHash,
                name,
                shared,
              ),
          },
          async () => definition.selector({ session }),
        );
        if (openedSandbox === undefined || selected !== openedSandbox) {
          throw new Error(
            `Sandbox "${definition.logicalPath}" must return the sandbox it creates.`,
          );
        }
      } catch (error) {
        handle = undefined;
        initialized = false;
        openedConfigurationHash = undefined;
        openedProviderName = undefined;
        openedSandbox = undefined;
        openedSessionKey = undefined;
        opening = undefined;
        providerOwned = false;
        throw error;
      }
    }

    if (handle === undefined) {
      throw new Error(`Sandbox "${definition.logicalPath}" did not create a provider handle.`);
    }
    return handle;
  }

  return {
    async captureState() {
      if (opening !== undefined) await opening;
      if (handle !== undefined) {
        if (openedProviderName === undefined || openedSessionKey === undefined) {
          throw new Error("The open sandbox is missing provider identity.");
        }
        persisted = {
          configurationHash: openedConfigurationHash,
          metadata: handle.captureMetadata ? await handle.captureMetadata() : handle.metadata,
          providerName: openedProviderName,
          sessionKey: openedSessionKey,
        };
      }
      return { initialized, session: persisted };
    },
    async delete(deleteOptions) {
      if (input.ownsSandbox === false)
        throw new Error("Only the owning session can delete this sandbox.");
      const current = await requireHandle();
      if (providerOwned) throw new Error("Named shared sandboxes have provider-owned lifetime.");
      await current.delete(deleteOptions);
      handle = undefined;
      initialized = false;
      openedConfigurationHash = undefined;
      openedProviderName = undefined;
      openedSandbox = undefined;
      openedSessionKey = undefined;
      opening = undefined;
      persisted = null;
      requiring = undefined;
    },
    async get() {
      return (await requireHandle()).sandbox;
    },
    async stop() {
      const current = await requireHandle();
      if (providerOwned)
        throw new Error("Named shared sandboxes cannot be stopped by one eve session.");
      await current.stop();
    },
  };
}

async function resolveProviderPreparedArtifact(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly providerName: string;
  readonly templateName: string | null;
}): Promise<SandboxProviderPreparedArtifact | undefined> {
  if (input.templateName === null) return undefined;
  const artifact = await loadSandboxPreparedArtifact({
    compiledArtifactsSource: input.compiledArtifactsSource,
    providerName: input.providerName,
    templateName: input.templateName,
  });
  if (artifact === undefined) {
    throw new SandboxTemplateNotProvisionedError({
      forceRebuild: false,
      providerName: input.providerName,
      templateKey: input.templateName,
    });
  }
  return { artifact, templateName: input.templateName };
}

async function getOrCreateWithRepair(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly create: () => Promise<RuntimeProviderHandle>;
  readonly providerName: string;
  readonly templateName: string | null;
}): Promise<RuntimeProviderHandle> {
  try {
    return await input.create();
  } catch (error) {
    if (
      input.templateName === null ||
      input.compiledArtifactsSource.kind !== "disk" ||
      !SandboxTemplateNotProvisionedError.is(error)
    ) {
      throw error;
    }
    await prewarmAppSandboxes({
      appRoot: input.appRoot,
      compiledArtifactsSource: input.compiledArtifactsSource,
      force: error.forceRebuild !== false,
      log: logDevelopmentSandbox,
    });
    await waitForSandboxTemplatePrewarmLock({
      appRoot: input.appRoot,
      log: (message) => logDevelopmentSandbox(`eve: ${message}`),
      providerName: input.providerName,
      templateKey: input.templateName,
    });
    logDevelopmentSandbox("eve: sandbox template is ready; retrying sandbox creation...");
    return await input.create();
  }
}

function logDevelopmentSandbox(message: string): void {
  if (isEveDevEnvironment()) console.log(message);
}

async function withDevelopmentSandboxProgress<T>(
  startMessage: string,
  progressMessage: string,
  callback: () => Promise<T>,
): Promise<T> {
  logDevelopmentSandbox(startMessage);
  if (!isEveDevEnvironment()) return await callback();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logDevelopmentSandbox(`${progressMessage} (${elapsedSeconds}s elapsed)...`);
  }, 5_000);
  timer.unref?.();
  try {
    return await callback();
  } finally {
    clearInterval(timer);
  }
}

function formatNodeLabel(nodeId: string): string {
  return nodeId === "__root__" ? "root" : nodeId;
}
