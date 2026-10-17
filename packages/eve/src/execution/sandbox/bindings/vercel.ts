import { randomBytes } from "node:crypto";

import type { VercelSandboxSession } from "#public/sandbox/vercel.js";
import { VERCEL_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
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
import { buildSandboxSession, SANDBOX_AGENT_ENV } from "#execution/sandbox/session.js";
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
  isVercelSandboxNameConflictError,
  isVercelSnapshotNotFoundError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { withToolSessionRetention } from "#execution/sandbox/bindings/vercel-tool-sessions.js";
import { isToolSessionId } from "#execution/tool-session/id.js";
import { withToolSessionSandboxes } from "#execution/tool-session/sandbox.js";
import {
  getNamedVercelSandbox,
  isVercelSnapshotCreated,
} from "#execution/sandbox/bindings/vercel-lookup.js";
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
  readonly snapshotId?: string;
};

export type VercelSandboxSessionState = {
  readonly sandboxName: string;
  readonly version: 3;
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
  VercelSandboxSession
> {
  const { prepare, ...authoredCreateOptions } = environmentOptions ?? {};
  return createVercelSandbox({ createOptions: authoredCreateOptions, prepare });
}

interface CreateVercelSandboxInput {
  readonly createSandbox?: CreateVercelSandbox;
  readonly createOptions?: VercelCreateOptions;
  readonly loadDeleteSandboxModule?: () => Promise<VercelModule>;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
  readonly skipEmptyPreparation?: boolean;
}

export function createVercelSandbox(
  input: CreateVercelSandboxInput = {},
): SandboxProviderImplementation<
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  VercelSandboxSession
> {
  const loadSandboxModule =
    input.loadSandboxModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const loadDeleteSandboxModule =
    input.loadDeleteSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: ResolvedVercelCreateOptions = {
    ...input.createOptions,
    timeout: input.createOptions?.timeout ?? DEFAULT_SANDBOX_TIMEOUT_MS,
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
    const toolSession = isToolSessionId(context.session.id);
    const authoredCreateOptions = { ...createOptions, ...runtimeOptions };
    const sessionCreateOptions = toolSession
      ? withToolSessionRetention(authoredCreateOptions)
      : authoredCreateOptions;
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
        // Only an expired snapshot gives a tool session a fresh sandbox.
        expired: toolSession ? isVercelSnapshotNotFoundError : isVercelSnapshotUnavailableError,
        input: ensureSessionInput,
        loadDeleteSandboxModule,
        session,
      });
      if (
        session.created &&
        artifact.snapshotId === undefined &&
        runtimeOptions.networkPolicy !== undefined
      ) {
        try {
          await applyInitialVercelNetworkPolicy(session.sandbox, runtimeOptions.networkPolicy);
        } catch (error) {
          try {
            await deleteVercelSandbox({
              createOptions: sessionCreateOptions,
              loadDeleteSandboxModule,
              sandbox: session.sandbox,
            });
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Failed to apply network policy and discard Vercel sandbox session "${context.session.id}".`,
              { cause: error },
            );
          }
          throw error;
        }
      }
    } catch (error) {
      if (isVercelSnapshotUnavailableError(error) && artifact.snapshotId !== undefined) {
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
    const handle = createHandle({
      createOptions: sessionCreateOptions,
      loadDeleteSandboxModule,
      sandbox: session.sandbox,
    });
    return handle;
  }

  const implementation: ReturnType<typeof createVercelSandbox> = {
    async prepare(context) {
      const seedFiles = providerResourceTargetFiles(context.resources);
      if (
        input.skipEmptyPreparation === true &&
        input.prepare === undefined &&
        seedFiles.length === 0
      )
        return {};
      const templateKey = `eve-sbx-tpl-vercel-${createSandboxProviderIdentity({
        createOptions: vercelIdentityOptions(createOptions),
        resolvedImage:
          createOptions.source === undefined
            ? (createOptions.image ?? VERCEL_EVE_SANDBOX_IMAGE)
            : undefined,
        resources: sandboxProviderResourceIdentity(context.resources),
        sourceRevision: context.sourceRevision,
        version: 3,
      }).slice(0, 32)}`;
      try {
        const snapshotId = await ensureTemplate({
          createOptions,
          createSandbox,
          loadSandboxModule,
          log: context.log,
          prepareSandbox: input.prepare,
          seedFiles,
          templateKey,
        });
        return { snapshotId };
      } catch (error) {
        throw new Error(`Failed to prepare Vercel sandbox snapshot: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    },
    async resume(_context, artifact, stateValue) {
      requirePreparedVercelTemplate(artifact);
      const state = requireVercelSessionState(stateValue);
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
      return createHandle({ createOptions, loadDeleteSandboxModule, sandbox });
    },
    async start(context, options, artifact) {
      const sandboxName = vercelSessionName(context.session.id, options, artifact, createOptions);
      const handle = await openSession(context, options, artifact, sandboxName);
      return {
        handle,
        state: { sandboxName, version: 3 },
      };
    },
  };
  // `start` finds a session's sandbox by name, so keyed tool sessions can reuse it.
  // A handle is only an SDK client, so a call that ends has nothing to free.
  return withToolSessionSandboxes(implementation);
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
    state.version !== 3 ||
    typeof state.sandboxName !== "string"
  ) {
    throw new Error("Invalid Vercel sandbox session state.");
  }
  return { sandboxName: state.sandboxName, version: 3 };
}

function requirePreparedVercelTemplate(
  artifact: SandboxPreparedArtifact,
): VercelSandboxPreparedArtifact {
  if (
    !isSandboxPreparedArtifactRecord(artifact) ||
    (artifact.snapshotId !== undefined && typeof artifact.snapshotId !== "string")
  ) {
    throw new Error("Invalid prepared Vercel sandbox artifact.");
  }
  return artifact.snapshotId === undefined ? {} : { snapshotId: artifact.snapshotId };
}

type VercelSeedFile = { readonly content: string | Uint8Array; readonly path: string };

/** Create options with the default sandbox timeout applied once. */
type ResolvedVercelCreateOptions = VercelCreateOptions & { readonly timeout: number };

interface EnsureTemplateInput {
  readonly prepareSandbox?: (sandbox: SandboxSession) => void | Promise<void>;
  readonly createOptions: ResolvedVercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<VercelSeedFile>;
  readonly templateKey: string;
}

/**
 * Returns the prepared snapshot for one template key. Builds of the same
 * revision share it through a pointer: a stopped sandbox named by the key,
 * created from a snapshot that finished preparing. Preparation itself runs
 * in a private sandbox no other build can see, so nothing under the shared
 * name ever holds unfinished work, and deleting a stale pointer can never
 * remove another build's preparation.
 */
async function ensureTemplate(input: EnsureTemplateInput): Promise<string> {
  const sandboxModule = await input.loadSandboxModule();
  const pointer = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule,
    sandboxName: input.templateKey,
  });
  const publishedSnapshotId = pointer?.sourceSnapshotId;
  if (
    publishedSnapshotId !== undefined &&
    (await isVercelSnapshotCreated({
      createOptions: input.createOptions,
      sandboxModule,
      snapshotId: publishedSnapshotId,
    }))
  ) {
    input.log?.("reusing prepared sandbox template");
    return publishedSnapshotId;
  }

  const snapshotId = await prepareTemplateSnapshot(input, sandboxModule);
  /*
   * The pointer only saves later builds a preparation; this build's snapshot
   * is already valid. So publishing never fails the build, including when a
   * build replacing the same stale pointer deletes this one mid-publish.
   */
  await publishTemplatePointer(input, sandboxModule, pointer, snapshotId).catch(
    (error: unknown) => {
      input.log?.(`could not publish sandbox template: ${errorMessage(error)}`);
    },
  );
  return snapshotId;
}

/** Prepares the template in a sandbox only this build knows, and returns its snapshot. */
async function prepareTemplateSnapshot(
  input: EnsureTemplateInput,
  sandboxModule: VercelModule,
): Promise<string> {
  /*
   * Not persistent: a sandbox this build abandons (killed, timed out) is
   * discarded without an automatic snapshot, and its name is unique, so no
   * other build ever finds it.
   */
  const sandbox = await input.createSandbox({
    sandboxModule,
    createOptions: withBaseSetupNetworkPolicy({
      ...input.createOptions,
      name: `${input.templateKey}-${randomBytes(4).toString("hex")}`,
      persistent: false,
    }),
  });
  try {
    input.log?.("preparing base runtime inside sandbox");
    await ensureVercelSandboxBaseRuntime(sandbox);
    await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);

    const templateSession = buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, input.createOptions.env),
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

    // The returned snapshot, not the handle's cached `currentSnapshotId`, which the SDK may not refresh.
    return (await sandbox.snapshot()).snapshotId;
  } finally {
    /*
     * A snapshot outlives its source sandbox, so the private sandbox is never
     * needed again. Failing to delete it doesn't change this build's result:
     * it's not persistent, and no other build looks it up.
     */
    await sandbox.delete().catch((error: unknown) => {
      input.log?.(`could not delete sandbox ${sandbox.name}: ${errorMessage(error)}`);
    });
  }
}

/**
 * Records a finished snapshot under the template key, replacing a stale
 * pointer. When another build published first, its snapshot is as valid as
 * this one, and this build keeps its own: there is nothing to read back.
 */
async function publishTemplatePointer(
  input: EnsureTemplateInput,
  sandboxModule: VercelModule,
  stalePointer: VercelSandbox | null,
  snapshotId: string,
): Promise<void> {
  if (stalePointer !== null) {
    try {
      await stalePointer.delete();
    } catch (error) {
      // Another build that saw the same stale pointer deleted it first.
      if (!isVercelSandboxMissingError(error)) throw error;
    }
  }
  // A snapshot source excludes `image`, `runtime`, and any authored source.
  const {
    image: _image,
    runtime: _runtime,
    source: _source,
    ...createOptions
  } = input.createOptions;
  let pointer: VercelSandbox;
  try {
    pointer = await input.createSandbox({
      sandboxModule,
      createOptions: {
        ...createOptions,
        name: input.templateKey,
        persistent: false,
        source: { snapshotId, type: "snapshot" },
      },
    });
  } catch (error) {
    if (isVercelSandboxNameConflictError(error)) return;
    throw error;
  }
  await stopVercelSandbox(pointer);
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
  readonly expired: (error: unknown) => boolean;
  readonly input: EnsureSessionInput;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly session: VercelSandboxSessionCreateResult;
}): Promise<VercelSandboxSessionCreateResult> {
  try {
    await ensureVercelSandboxBaseRuntime(input.session.sandbox);
    return input.session;
  } catch (error) {
    if (input.session.created || !input.expired(error)) {
      throw error;
    }
  }

  try {
    await deleteUnusableVercelSandbox({
      createOptions: input.input.createOptions,
      loadDeleteSandboxModule: input.loadDeleteSandboxModule,
      sandbox: input.session.sandbox,
    });
  } catch (error) {
    // Another instance that saw the same expiry deleted it first.
    if (!isVercelSandboxMissingError(error)) throw error;
  }
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

  try {
    return {
      created: true,
      sandbox: await input.createSandbox({
        createOptions: createParams,
        sandboxModule: input.sandboxModule,
      }),
    };
  } catch (error) {
    // Lookup-then-create is not atomic: another instance created the name first.
    if (!isVercelSandboxNameConflictError(error)) throw error;
    const winner = await getNamedVercelSandbox({ ...input, sandboxName });
    if (winner === null) throw error;
    return { created: false, sandbox: winner };
  }
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

function createHandle(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
}): SandboxProviderHandle<VercelSandboxSession> {
  const { sandbox } = input;
  return {
    sandbox: {
      ...buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, input.createOptions.env),
        createVercelNetworkPolicySetter(sandbox),
      ),
      name: sandbox.name,
    },
    async onSandboxDelete(options) {
      await deleteVercelSandbox({
        createOptions: input.createOptions,
        loadDeleteSandboxModule: input.loadDeleteSandboxModule,
        sandbox,
        signal: options?.abortSignal,
      });
    },
    async onSandboxStop() {
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

function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  environmentEnv: Readonly<Record<string, string>> | undefined,
): InternalSandboxSession {
  const baseEnv = { ...SANDBOX_AGENT_ENV, ...environmentEnv };
  return {
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await sandbox.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: { ...baseEnv, ...options.env },
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

/**
 * 30 minutes. The `@vercel/sandbox` SDK defaults to 5 minutes which is
 * too short for multi-step workflows — the VM expires between steps.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
