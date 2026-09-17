import type { MutableNetworkSandboxSession } from "#shared/sandbox-session.js";
import {
  applyInitialVercelNetworkPolicy,
  createVercelNetworkPolicySetter,
  ensureVercelSandboxBaseRuntime,
  withBaseSetupNetworkPolicy,
} from "#execution/sandbox/bindings/vercel-base-runtime.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import {
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  providerResourceTargetFiles,
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type {
  VercelSandboxMountOptions,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import {
  createVercelEveImageSandbox,
  type CreateVercelSandbox,
  type VercelSandboxCreateParams,
} from "#execution/sandbox/bindings/vercel-create-sdk.js";
import {
  errorMessage,
  ensureVercelSandboxTags,
  resolveVercelSandboxTags,
} from "#execution/sandbox/bindings/vercel-options.js";
import {
  isVercelSandboxMissingError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import {
  deleteUnusableVercelSandbox,
  deleteVercelSandbox,
  stopVercelSandbox,
} from "#execution/sandbox/bindings/vercel-lifecycle.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export type VercelSandboxPreparedArtifact = {
  readonly snapshotId: string;
};

export type VercelSandboxSessionState = {
  readonly generation: string;
  readonly sandboxName: string;
  readonly version: 2;
};

type VercelEnvironmentOptions = VercelCreateOptions & {
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
};

export function createVercelSandboxProvider(
  environmentOptions: Readonly<VercelEnvironmentOptions> | undefined,
): SandboxProviderImplementation<
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  MutableNetworkSandboxSession
> {
  const { prepare, ...authoredCreateOptions } = environmentOptions ?? {};
  return createVercelSandbox({ createOptions: authoredCreateOptions, prepare });
}

export interface CreateVercelSandboxInput {
  readonly createSandbox?: CreateVercelSandbox;
  readonly createOptions?: VercelCreateOptions;
  readonly loadDeleteSandboxModule?: () => Promise<VercelModule>;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
}

export function createVercelSandbox(
  input: CreateVercelSandboxInput = {},
): SandboxProviderImplementation<
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  MutableNetworkSandboxSession
> {
  const loadSandboxModule =
    input.loadSandboxModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const loadDeleteSandboxModule =
    input.loadDeleteSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...input.createOptions,
  };
  const createSandbox = input.createSandbox ?? createVercelEveImageSandbox;

  async function openSession(
    context: SandboxProviderSessionContext,
    options: Readonly<VercelSandboxRuntimeOptions> | undefined,
    artifactValue: SandboxPreparedArtifact,
    sandboxName: string,
  ) {
    const artifact = requirePreparedVercelTemplate(artifactValue);
    const { mounts, ...runtimeOptions } = options ?? {};
    const sessionCreateOptions = { ...createOptions, ...runtimeOptions };
    const tags = resolveVercelSandboxTags(sessionCreateOptions.tags, {
      sessionId: context.session.id,
    });
    const sandboxModule = await loadSandboxModule();
    const ensureSessionInput: EnsureSessionInput = {
      createOptions: sessionCreateOptions,
      createSandbox,
      resolveSessionCreateOptions: mounts === undefined ? undefined : async () => ({ mounts }),
      sandboxModule,
      sessionKey: sandboxName,
      snapshotId: artifact.snapshotId,
      tags,
    };
    let session: VercelSandboxSessionCreateResult;
    try {
      session = await ensureSession(ensureSessionInput);
      session = await ensureUsableSession({
        input: ensureSessionInput,
        loadDeleteSandboxModule,
        session,
      });
    } catch (error) {
      if (isVercelSnapshotUnavailableError(error)) {
        throw new SandboxTemplateNotProvisionedError({
          providerName: "vercel",
          templateKey: artifact.snapshotId,
        });
      }
      throw new Error(
        `Failed to open Vercel sandbox session "${context.session.id}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const handle = createVercelSandboxHandle({
      createOptions: sessionCreateOptions,
      loadDeleteSandboxModule,
      sandbox: session.sandbox,
    });
    return handle;
  }

  return {
    async prepare(context) {
      const templateKey = `eve-sbx-tpl-vercel-${createSandboxProviderIdentity({
        createOptions: vercelIdentityOptions(createOptions),
        prepare: input.prepare,
        resources: sandboxProviderResourceIdentity(context.resources),
        version: 1,
      }).slice(0, 32)}`;
      try {
        const outcome = await ensureTemplateWithUnavailableRetry({
          createOptions,
          createSandbox,
          loadSandboxModule,
          log: context.log,
          prepareSandbox: input.prepare,
          seedFiles: providerResourceTargetFiles(context.resources),
          templateKey,
        });
        return { snapshotId: outcome.template.snapshotId };
      } catch (error) {
        throw new Error(`Failed to prepare Vercel sandbox snapshot: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    },
    async resume(_context, artifact, stateValue) {
      requirePreparedVercelTemplate(artifact);
      const state = requireVercelSessionState(stateValue);
      if (state.generation !== vercelGeneration(artifact, createOptions)) {
        throw new Error("Vercel sandbox session state is incompatible with this environment.");
      }
      const sandboxModule = await loadSandboxModule();
      const sandbox = await getNamedVercelSandbox({
        createOptions,
        sandboxModule,
        sandboxName: state.sandboxName,
      });
      if (sandbox === null) {
        throw new Error(`Vercel sandbox session "${state.sandboxName}" no longer exists.`);
      }
      await ensureVercelSandboxBaseRuntime(sandbox);
      return createVercelSandboxHandle({ createOptions, loadDeleteSandboxModule, sandbox });
    },
    async start(context, options, artifact) {
      const sandboxName = vercelSessionName(context.session.id, options, artifact, createOptions);
      const handle = await openSession(context, options, artifact, sandboxName);
      return {
        handle,
        state: { generation: vercelGeneration(artifact, createOptions), sandboxName, version: 2 },
      };
    },
  };
}

interface VercelSandboxTemplateRecord {
  readonly sandboxName: string;
  readonly snapshotId: string;
  readonly templateKey: string;
}

function vercelGeneration(
  artifact: SandboxPreparedArtifact,
  createOptions: VercelCreateOptions,
): string {
  return createSandboxProviderIdentity({
    artifact: requirePreparedVercelTemplate(artifact),
    createOptions: vercelIdentityOptions(createOptions),
    version: 1,
  });
}

function vercelSessionName(
  sessionId: string,
  options: Readonly<VercelSandboxRuntimeOptions> | undefined,
  artifactValue: SandboxPreparedArtifact,
  createOptions: VercelCreateOptions,
): string {
  const artifact = requirePreparedVercelTemplate(artifactValue);
  return `eve-sbx-vercel-${createSandboxProviderIdentity({
    artifact,
    createOptions: vercelIdentityOptions(createOptions),
    options: vercelIdentityOptions(options),
    sessionId,
    version: 1,
  }).slice(0, 32)}`;
}

function vercelIdentityOptions(options: object | undefined): object | undefined {
  if (options === undefined) return undefined;
  const excluded = new Set(["fetch", "projectId", "signal", "teamId", "token"]);
  return Object.fromEntries(Object.entries(options).filter(([key]) => !excluded.has(key)));
}

function requireVercelSessionState(state: SandboxPreparedArtifact): VercelSandboxSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 2 ||
    typeof state.generation !== "string" ||
    typeof state.sandboxName !== "string"
  ) {
    throw new Error("Invalid Vercel sandbox session state.");
  }
  return { generation: state.generation, sandboxName: state.sandboxName, version: 2 };
}

function requirePreparedVercelTemplate(
  artifact: SandboxPreparedArtifact,
): VercelSandboxPreparedArtifact {
  if (!isSandboxPreparedArtifactRecord(artifact) || typeof artifact.snapshotId !== "string") {
    throw new Error("Invalid prepared Vercel sandbox artifact.");
  }
  return { snapshotId: artifact.snapshotId };
}

interface EnsureTemplateOutcome {
  readonly template: VercelSandboxTemplateRecord;
}

type VercelSeedFile = { readonly content: string | Uint8Array; readonly path: string };

interface EnsureTemplateInput {
  readonly prepareSandbox?: (sandbox: SandboxSession) => void | Promise<void>;
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<VercelSeedFile>;
  readonly tags?: Record<string, string>;
  readonly templateKey: string;
}

async function ensureTemplateWithUnavailableRetry(
  input: EnsureTemplateInput,
): Promise<EnsureTemplateOutcome> {
  try {
    return await ensureTemplate(input);
  } catch (error) {
    if (!isVercelSnapshotUnavailableError(error) && !isVercelSandboxMissingError(error)) {
      throw error;
    }
    input.log?.("cached template disappeared; rebuilding sandbox template");
    return await ensureTemplate(input);
  }
}

/**
 * Creates or refreshes one named Vercel sandbox template and returns the
 * resulting snapshot metadata along with whether an existing snapshot
 * was reused. This runs only from the provider's preparation phase.
 */
async function ensureTemplate(input: EnsureTemplateInput): Promise<EnsureTemplateOutcome> {
  const sandboxModule = await input.loadSandboxModule();
  let sandbox = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule,
    sandboxName: input.templateKey,
  });
  const tags = resolveVercelSandboxTags(input.createOptions.tags, input.tags);
  const authorSnapshotId = extractAuthorSnapshotId(input.createOptions);

  if (sandbox !== null && isUnprovisionedTerminalTemplateSandbox(sandbox, authorSnapshotId)) {
    await sandbox.delete();
    sandbox = null;
  }

  if (sandbox === null) {
    sandbox = await input.createSandbox({
      sandboxModule,
      createOptions: withBaseSetupNetworkPolicy({
        ...input.createOptions,
        name: input.templateKey,
        persistent: true,
        tags: tags,
      }),
    });
  } else {
    await ensureVercelSandboxTags(sandbox, tags);
  }

  /*
   * A non-empty `currentSnapshotId` normally means "this template was
   * prewarmed in a previous run — reuse it." But with an author-supplied
   * `source: snapshot`, the SDK pre-populates `currentSnapshotId` with
   * the *author's* snapshotId both on a fresh create and on every
   * subsequent `getNamedSandbox` reuse until we run our own snapshot.
   * So we ignore that exact value: it's the author's base layer, not a
   * framework snapshot, and we still owe `ensureSandboxWorkingDirectory`,
   * preparation, seed file writes, and `sandbox.snapshot()` on top.
   */
  const frameworkSnapshotId =
    typeof sandbox.currentSnapshotId === "string" &&
    sandbox.currentSnapshotId.length > 0 &&
    sandbox.currentSnapshotId !== authorSnapshotId
      ? sandbox.currentSnapshotId
      : null;

  if (frameworkSnapshotId !== null) {
    return {
      template: {
        sandboxName: sandbox.name,
        snapshotId: frameworkSnapshotId,
        templateKey: input.templateKey,
      },
    };
  }

  input.log?.("preparing base runtime inside sandbox");
  await ensureVercelSandboxBaseRuntime(sandbox);
  await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);

  const templateSession = buildSandboxSession(
    createVercelInternalSandboxSession(sandbox),
    createVercelNetworkPolicySetter(sandbox),
  );

  await writeVercelSandboxSeedFiles({
    sandbox,
    seedFiles: input.seedFiles,
    session: templateSession,
  });

  input.log?.("running sandbox preparation");
  await input.prepareSandbox?.(
    createLoggingSandboxSession({ log: input.log, session: templateSession }),
  );

  const snapshot = await sandbox.snapshot();
  return {
    template: {
      sandboxName: sandbox.name,
      snapshotId: snapshot.snapshotId,
      templateKey: input.templateKey,
    },
  };
}

interface EnsureSessionInput {
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly resolveSessionCreateOptions?: () =>
    | Promise<VercelSandboxMountOptions>
    | VercelSandboxMountOptions;
  readonly sandboxModule: VercelModule;
  readonly sessionKey: string;
  readonly snapshotId?: string;
  readonly tags: Record<string, string> | undefined;
}

interface VercelSandboxSessionCreateResult {
  readonly created: boolean;
  readonly sandbox: VercelSandbox;
}

async function ensureUsableSession(input: {
  readonly input: EnsureSessionInput;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly session: VercelSandboxSessionCreateResult;
}): Promise<VercelSandboxSessionCreateResult> {
  try {
    await ensureVercelSandboxBaseRuntime(input.session.sandbox);
    return input.session;
  } catch (error) {
    if (input.session.created || !isVercelSnapshotUnavailableError(error)) {
      throw error;
    }
  }

  await deleteUnusableVercelSandbox({
    createOptions: input.input.createOptions,
    loadDeleteSandboxModule: input.loadDeleteSandboxModule,
    sandbox: input.session.sandbox,
  });
  const replacement = await ensureSession(input.input);
  await ensureVercelSandboxBaseRuntime(replacement.sandbox);
  return replacement;
}

async function ensureSession(input: EnsureSessionInput): Promise<VercelSandboxSessionCreateResult> {
  const sandboxName = input.sessionKey;
  const existing = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule: input.sandboxModule,
    sandboxName,
  });

  if (existing !== null) {
    await ensureVercelSandboxTags(existing, input.tags);
    return { created: false, sandbox: existing };
  }

  const sessionCreateOptions = await input.resolveSessionCreateOptions?.();
  const createParams = createSessionCreateParams(input, sandboxName, sessionCreateOptions);
  if (input.tags !== undefined) {
    createParams.tags = input.tags;
  }

  return {
    created: true,
    sandbox: await input.createSandbox({
      createOptions: createParams,
      sandboxModule: input.sandboxModule,
    }),
  };
}

function createSessionCreateParams(
  input: EnsureSessionInput,
  sandboxName: string,
  sessionCreateOptions: VercelSandboxMountOptions = {},
): VercelSandboxCreateParams {
  const createOptions: VercelCreateOptions = {
    ...input.createOptions,
    ...sessionCreateOptions,
  };
  if (input.snapshotId === undefined) {
    return withBaseSetupNetworkPolicy({
      ...createOptions,
      name: sandboxName,
      persistent: true,
    });
  }

  /*
   * Strip `source`, `runtime`, and `image` from author-supplied create options
   * for the template-backed session path. The framework owns the source there,
   * and a snapshot source is mutually exclusive with both `runtime` and `image`
   * (the template snapshot already has the eve image baked in).
   */
  const {
    image: _image,
    runtime: _runtime,
    source: _source,
    ...baseSessionCreateOptions
  } = createOptions;

  return {
    ...baseSessionCreateOptions,
    name: sandboxName,
    persistent: true,
    source: { snapshotId: input.snapshotId, type: "snapshot" },
  };
}

export function createVercelSandboxHandle(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
}): SandboxProviderHandle<MutableNetworkSandboxSession> {
  const { sandbox } = input;
  return {
    sandbox: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox),
      createVercelNetworkPolicySetter(sandbox),
    ),
    async onSessionDelete(options) {
      await deleteVercelSandbox({
        createOptions: input.createOptions,
        loadDeleteSandboxModule: input.loadDeleteSandboxModule,
        sandbox,
        signal: options?.abortSignal,
      });
    },
    async onSessionStop() {
      await stopVercelSandbox(sandbox);
    },
    async onRuntimeShutdown() {
      try {
        await stopVercelSandbox(sandbox);
      } catch {
        // Provider-side timeout is the backstop when the sandbox is unreachable.
      }
    },
  };
}

export function createVercelInternalSandboxSession(sandbox: VercelSandbox): InternalSandboxSession {
  return {
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await sandbox.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.stream,
      });
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(await sandbox.readFile({ path: options.path }));
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      const path = await resolveVercelWritePath(sandbox, options.path, options.abortSignal);
      await sandbox.writeFiles([{ content: bytes, path }], { signal: options.abortSignal });
    },
    async removePath(options: SandboxRemovePathOptions) {
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

async function writeVercelSandboxSeedFiles(input: {
  readonly sandbox: VercelSandbox;
  readonly seedFiles: ReadonlyArray<VercelSeedFile>;
  readonly session: SandboxSession;
}): Promise<void> {
  if (input.seedFiles.length === 0) {
    return;
  }

  const files = await Promise.all(
    input.seedFiles.map(async (file) => ({
      content: typeof file.content === "string" ? Buffer.from(file.content) : file.content,
      path: await resolveSandboxModelPath({
        path: file.path,
        sandbox: input.session,
      }),
    })),
  );

  await input.sandbox.writeFiles(files);
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}

async function resolveVercelWritePath(
  sandbox: VercelSandbox,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await sandbox.runCommand({
    args: ["-m", "--", path],
    cmd: "realpath",
    signal,
  });
  const resolved = (await result.stdout()).trim();
  if (result.exitCode !== 0 || !resolved.startsWith("/") || resolved.includes("\n")) {
    throw new Error(`Failed to resolve Vercel Sandbox write path: ${path}`);
  }
  return resolved;
}

function isUnprovisionedTerminalTemplateSandbox(
  sandbox: VercelSandbox,
  authorSnapshotId: string | undefined,
): boolean {
  const currentSnapshotId = sandbox.currentSnapshotId;
  if (
    typeof currentSnapshotId === "string" &&
    currentSnapshotId.length > 0 &&
    currentSnapshotId !== authorSnapshotId
  ) {
    return false;
  }

  return (
    sandbox.status === "aborted" || sandbox.status === "failed" || sandbox.status === "stopped"
  );
}

/**
 * Pulls the snapshotId out of an author-supplied `source: { type:
 * "snapshot", ... }`. Returns undefined for git/tarball sources or when
 * no source was supplied — those don't seed `currentSnapshotId` with a
 * pre-existing value the way snapshot sources do.
 */
function extractAuthorSnapshotId(createOptions: VercelCreateOptions): string | undefined {
  const source = createOptions.source;
  if (source?.type === "snapshot" && typeof source.snapshotId === "string") {
    return source.snapshotId;
  }
  return undefined;
}

/**
 * 30 minutes. The `@vercel/sandbox` SDK defaults to 5 minutes which is
 * too short for multi-step workflows — the VM expires between steps.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
