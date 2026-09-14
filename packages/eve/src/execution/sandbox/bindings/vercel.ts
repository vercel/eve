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
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderResources,
  type SandboxProviderTags,
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
  VercelDeleteModule,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export function createVercelSandboxProvider(
  environmentOptions: VercelCreateOptions,
): SandboxProviderImplementation<VercelSandboxRuntimeOptions, Record<string, unknown>> {
  return createVercelSandbox({ createOptions: environmentOptions });
}

export interface CreateVercelSandboxInput {
  readonly createSandbox?: CreateVercelSandbox;
  readonly createOptions?: VercelCreateOptions;
  readonly loadDeleteSandboxModule?: () => Promise<VercelDeleteModule>;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
}
/**
 * Creates the Vercel-backed sandbox provider.
 *
 * Any author-supplied `createOptions` are forwarded to Vercel's sandbox
 * create API for every fresh sandbox the framework creates (template at
 * prewarm time, session at first-time session-create). On resume
 * (`Sandbox.get`) no create happens, so they are not re-applied.
 */
export function createVercelSandbox(
  input: CreateVercelSandboxInput = {},
): SandboxProviderImplementation<VercelSandboxRuntimeOptions, Record<string, unknown>> {
  const loadSandboxModule =
    input.loadSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox-drives/index.js"));
  const loadDeleteSandboxModule =
    input.loadDeleteSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...input.createOptions,
  };
  const createSandbox = input.createSandbox ?? createVercelEveImageSandbox;

  return {
    async getOrCreate(context, prepared) {
      const { mounts, ...runtimeOptions } = context.options;
      const sessionCreateOptions = { ...createOptions, ...runtimeOptions };
      // Resolve tags up-front so tag-count validation fails fast before
      // we go to the network for the template snapshot.
      const tags = resolveVercelSandboxTags(sessionCreateOptions.tags, context.tags);

      const template =
        prepared === undefined
          ? null
          : requirePreparedVercelTemplate(prepared.artifact, prepared.templateName);

      const sandboxModule = await loadSandboxModule();
      const ensureSessionInput: EnsureSessionInput = {
        createOptions: sessionCreateOptions,
        createSandbox,
        existingMetadata: context.existing,
        resolveSessionCreateOptions: mounts === undefined ? undefined : async () => ({ mounts }),
        sandboxModule,
        sessionId: context.tags?.sessionId ?? context.sandboxName,
        sessionKey: context.sandboxName,
        snapshotId: template?.snapshotId,
        tags,
      };
      let session: VercelSandboxSessionCreateResult;
      try {
        session = await ensureSession(ensureSessionInput);
      } catch (error) {
        if (prepared !== undefined && isVercelSnapshotUnavailableError(error)) {
          throw new SandboxTemplateNotProvisionedError({
            providerName: "vercel",
            templateKey: prepared.templateName,
          });
        }
        throw new Error(
          `Failed to create sandbox session "${context.sandboxName}": ${errorMessage(error)}`,
          { cause: error },
        );
      }

      try {
        session = await ensureUsableSession({
          input: ensureSessionInput,
          loadDeleteSandboxModule,
          session,
        });
        if (template === null && session.created) {
          await applyInitialVercelNetworkPolicy(
            session.sandbox,
            sessionCreateOptions.networkPolicy,
          );
        }
      } catch (error) {
        throw new Error(
          `Failed to initialize sandbox session "${context.sandboxName}": ${errorMessage(error)}`,
          { cause: error },
        );
      }

      return context.handle(
        createHandle({
          createOptions: sessionCreateOptions,
          loadDeleteSandboxModule,
          sandbox: session.sandbox,
          sessionKey: context.sandboxName,
        }),
      );
    },
    async prepare(context) {
      let outcome: EnsureTemplateOutcome;
      try {
        outcome = await ensureTemplateWithUnavailableRetry({
          force: context.force,
          runPreparation: context.runPreparation,
          createOptions,
          createSandbox,
          loadSandboxModule,
          log: context.log,
          seedFiles: providerSeedFiles(context.resources),
          templateKey: context.templateName,
        });
      } catch (error) {
        throw new Error(
          `Failed to prepare Vercel sandbox template "${context.templateName}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
      return {
        artifact: { snapshotId: outcome.template.snapshotId },
        reused: outcome.reused,
      };
    },
  };
}

interface VercelSandboxTemplateRecord {
  readonly sandboxName: string;
  readonly snapshotId: string;
  readonly templateKey: string;
}

interface VercelSandboxPreparedArtifact {
  readonly snapshotId: string;
}

function requirePreparedVercelTemplate(
  artifact: SandboxPreparedArtifact | undefined,
  templateKey: string,
): VercelSandboxPreparedArtifact {
  if (artifact === undefined) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: "vercel",
      templateKey,
    });
  }
  if (!isSandboxPreparedArtifactRecord(artifact) || typeof artifact.snapshotId !== "string") {
    throw new Error(`Invalid prepared Vercel sandbox artifact for template "${templateKey}".`);
  }
  return { snapshotId: artifact.snapshotId };
}

interface EnsureTemplateOutcome {
  readonly reused: boolean;
  readonly template: VercelSandboxTemplateRecord;
}

type VercelSeedFile = { readonly content: string | Uint8Array; readonly path: string };

interface EnsureTemplateInput {
  readonly force?: boolean;
  readonly runPreparation?: (sandbox: SandboxSession) => void | Promise<void>;
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<VercelSeedFile>;
  readonly tags?: SandboxProviderTags;
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
 * was reused. Internal — exposed only to the prewarm pipeline through
 * the backend's `prewarm` method.
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

  if (
    sandbox !== null &&
    (input.force === true || isUnprovisionedTerminalTemplateSandbox(sandbox, authorSnapshotId))
  ) {
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
  const hasFrameworkSnapshot =
    typeof sandbox.currentSnapshotId === "string" &&
    sandbox.currentSnapshotId.length > 0 &&
    sandbox.currentSnapshotId !== authorSnapshotId;

  if (hasFrameworkSnapshot) {
    return {
      reused: true,
      template: {
        sandboxName: sandbox.name,
        snapshotId: sandbox.currentSnapshotId as string,
        templateKey: input.templateKey,
      },
    };
  }

  input.log?.("preparing base runtime inside sandbox");
  await ensureVercelSandboxBaseRuntime(sandbox);
  await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);

  const templateSession = buildSandboxSession(
    createVercelInternalSandboxSession(sandbox, input.templateKey),
    createVercelNetworkPolicySetter(sandbox),
  );

  await writeVercelSandboxSeedFiles({
    sandbox,
    seedFiles: input.seedFiles,
    session: templateSession,
  });

  input.log?.("running sandbox preparation");
  await input.runPreparation?.(
    createLoggingSandboxSession({ log: input.log, session: templateSession }),
  );

  const snapshot = await sandbox.snapshot();
  return {
    reused: false,
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
  readonly existingMetadata?: Record<string, unknown>;
  readonly resolveSessionCreateOptions?: () =>
    | Promise<VercelSandboxMountOptions>
    | VercelSandboxMountOptions;
  readonly sandboxModule: VercelModule;
  readonly sessionId: string;
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
  readonly loadDeleteSandboxModule: () => Promise<VercelDeleteModule>;
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
  const replacement = await ensureSession({ ...input.input, existingMetadata: undefined });
  await ensureVercelSandboxBaseRuntime(replacement.sandbox);
  return replacement;
}

async function ensureSession(input: EnsureSessionInput): Promise<VercelSandboxSessionCreateResult> {
  const sandboxName = getVercelSandboxName(input.existingMetadata) ?? input.sessionKey;
  const existing = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule: input.sandboxModule,
    sandboxName,
  });

  if (existing !== null) {
    const expectedConfig = input.tags?.sandboxConfig;
    if (expectedConfig !== undefined && existing.tags?.sandboxConfig !== expectedConfig) {
      throw new Error(
        `Named sandbox "${sandboxName}" was requested with conflicting configuration.`,
      );
    }
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
  const createOptions = { ...input.createOptions, ...sessionCreateOptions } as VercelCreateOptions;
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
  } = createOptions as VercelCreateOptions &
    Partial<Record<"image" | "runtime" | "source", unknown>>;

  return {
    ...baseSessionCreateOptions,
    name: sandboxName,
    persistent: true,
    source: { snapshotId: input.snapshotId, type: "snapshot" as const },
  };
}

function createHandle(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelDeleteModule>;
  readonly sandbox: VercelSandbox;
  readonly sessionKey: string;
}): SandboxProviderHandle<Record<string, unknown>> {
  const { sandbox, sessionKey } = input;
  return {
    metadata: { sandboxName: sandbox.name },
    sandbox: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey),
      createVercelNetworkPolicySetter(sandbox),
    ),
    async delete(options) {
      await deleteVercelSandbox({
        createOptions: input.createOptions,
        loadDeleteSandboxModule: input.loadDeleteSandboxModule,
        sandbox,
        signal: options?.abortSignal,
      });
    },
    async stop() {
      await stopVercelSandbox(sandbox);
    },
    async shutdown() {
      try {
        await stopVercelSandbox(sandbox);
      } catch {
        // Provider-side timeout is the backstop when the sandbox is unreachable.
      }
    },
  };
}

function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
): InternalSandboxSession {
  return {
    id,
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

function providerSeedFiles(resources: SandboxProviderResources): VercelSeedFile[] {
  return [
    ...(resources.workspace?.files.map((file) => ({
      content: file.content,
      path: `${resources.workspace?.targetPath}/${file.relativePath}`,
    })) ?? []),
    ...(resources.skills?.files.map((file) => ({
      content: file.content,
      path: `${resources.skills?.targetPath}/${file.relativePath}`,
    })) ?? []),
  ];
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
  const source = (createOptions as { source?: { type?: string; snapshotId?: string } }).source;
  if (source?.type === "snapshot" && typeof source.snapshotId === "string") {
    return source.snapshotId;
  }
  return undefined;
}

function getVercelSandboxName(metadata: Record<string, unknown> | undefined): string | undefined {
  const sandboxName = metadata?.sandboxName;
  return typeof sandboxName === "string" ? sandboxName : undefined;
}

/**
 * 30 minutes. The `@vercel/sandbox` SDK defaults to 5 minutes which is
 * too short for multi-step workflows — the VM expires between steps.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
