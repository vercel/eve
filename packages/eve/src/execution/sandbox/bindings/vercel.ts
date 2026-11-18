import { randomBytes } from "node:crypto";

import type {
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxWriteFilesOptions,
} from "#public/sandbox/index.js";
import {
  SANDBOX_AGENT_ENV,
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type SandboxConnection,
  type SandboxJson,
  type SandboxPrepareContext,
  type SandboxProviderImplementation,
  type SandboxSessionContext,
} from "#public/sandbox/provider.js";
import type {
  VercelSandboxMountMode,
  VercelSandboxMounts,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";
import type { VercelSandboxSession } from "#public/sandbox/vercel.js";
import {
  VERCEL_EVE_GIT_SANDBOX_IMAGE,
  VERCEL_EVE_SANDBOX_IMAGE,
} from "#execution/sandbox/bindings/eve-image.js";
import {
  applyInitialVercelNetworkPolicy,
  createVercelNetworkPolicySetter,
  ensureVercelSandboxBaseRuntime,
  toVercelNetworkPolicy,
  withBaseSetupNetworkPolicy,
} from "#execution/sandbox/bindings/vercel-base-runtime.js";
import {
  createVercelEveImageSandbox,
  type CreateVercelSandbox,
  type VercelSandboxCreateParams,
} from "#execution/sandbox/bindings/vercel-create-sdk.js";
import { createVercelDeadline } from "#execution/sandbox/bindings/vercel-deadline.js";
import {
  isVercelSandboxMissingError,
  isVercelSandboxNameConflictError,
  isVercelSnapshotNotFoundError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import {
  deleteNamedVercelSandbox,
  deleteUnusableVercelSandbox,
  stopVercelSandbox,
} from "#execution/sandbox/bindings/vercel-lifecycle.js";
import {
  getNamedVercelSandbox,
  isVercelSnapshotCreated,
} from "#execution/sandbox/bindings/vercel-lookup.js";
import {
  errorMessage,
  ensureVercelSandboxTags,
  resolveVercelSandboxTags,
} from "#execution/sandbox/bindings/vercel-options.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { withToolSessionRetention } from "#execution/sandbox/bindings/vercel-tool-sessions.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { isObject } from "#shared/guards.js";
import {
  invalidPreparedSandboxArtifactError,
  invalidSandboxSessionStateError,
} from "#shared/sandbox-recorded-data-error.js";

export type VercelSandboxPreparedArtifact = {
  readonly snapshotId?: string;
};

export type VercelSandboxSessionState = {
  readonly sandboxName: string;
  readonly version: 3;
};

export type VercelSandboxExtensions = Pick<VercelSandboxSession, "name" | "setNetworkPolicy">;

interface CreateVercelSandboxInput {
  readonly createSandbox?: CreateVercelSandbox;
  readonly createOptions?: VercelCreateOptions;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
}

export function createVercelSandbox(
  input: CreateVercelSandboxInput = {},
): SandboxProviderImplementation<
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  VercelSandboxSessionState,
  VercelSandboxExtensions
> {
  const loadSandboxModule =
    input.loadSandboxModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: ResolvedVercelCreateOptions = {
    ...input.createOptions,
    env: { ...SANDBOX_AGENT_ENV, ...input.createOptions?.env },
    timeout: input.createOptions?.timeout ?? DEFAULT_SANDBOX_TIMEOUT_MS,
  };
  const createSandbox = input.createSandbox ?? createVercelEveImageSandbox;
  const image = createOptions.image ?? VERCEL_EVE_SANDBOX_IMAGE;
  const usesEveBase =
    createOptions.source === undefined &&
    (image === VERCEL_EVE_SANDBOX_IMAGE || image === VERCEL_EVE_GIT_SANDBOX_IMAGE);

  return {
    async onSessionEnd(context, state, { signal }) {
      await deleteNamedVercelSandbox({
        createOptions,
        sandboxModule: await loadSandboxModule(),
        sandboxName: state?.sandboxName ?? vercelSessionName(context.session.id),
        signal,
      });
    },
    async attach(context, state, { signal }) {
      const sandbox = await getNamedVercelSandbox({
        createOptions: signal === undefined ? createOptions : { ...createOptions, signal },
        sandboxModule: await loadSandboxModule(),
        sandboxName: state?.sandboxName ?? vercelSessionName(context.session.id),
      });
      if (sandbox === null || (sandbox.status !== "running" && sandbox.status !== "pending"))
        return null;
      const { spawn } = createVercelConnection(sandbox, sandbox.currentSession());
      return {
        spawn,
        async stop(options) {
          try {
            await stopVercelSandbox(sandbox, options?.signal);
          } catch (error) {
            if (!isVercelSandboxMissingError(error)) throw error;
          }
        },
      };
    },
    async prepare(context) {
      if (context.isEmpty && createOptions.source === undefined) return {};
      try {
        const templateKey = `eve-sbx-tpl-vercel-${context
          .templateKey({
            createOptions: vercelIdentityOptions(createOptions),
            resolvedImage: createOptions.source === undefined ? image : undefined,
            version: 4,
          })
          .slice(0, 32)}`;
        const snapshotId = await ensureTemplate({
          context,
          createOptions,
          createSandbox,
          loadSandboxModule,
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
        throw new SandboxSessionGoneError(
          `Vercel sandbox session "${state.sandboxName}" no longer exists.`,
        );
      }
      try {
        await ensureVercelSandboxBaseRuntime(sandbox);
      } catch (error) {
        if (isVercelSnapshotNotFoundError(error)) {
          throw new SandboxSessionGoneError(
            `Vercel sandbox session "${state.sandboxName}" can no longer resume: its snapshot expired or was deleted.`,
          );
        }
        throw error;
      }
      return createVercelConnection(sandbox);
    },
    async start(context, options, artifact) {
      const sandboxName = vercelSessionName(context.session.id);
      const sandbox = await openSession(context, options, artifact, sandboxName);
      return { connection: createVercelConnection(sandbox), state: { sandboxName, version: 3 } };
    },
    toolSessions: true,
  };

  async function openSession(
    context: SandboxSessionContext,
    options: Readonly<VercelSandboxRuntimeOptions> | undefined,
    artifactValue: SandboxJson,
    sandboxName: string,
  ): Promise<VercelSandbox> {
    const artifact = requirePreparedVercelTemplate(artifactValue);
    const { mounts, networkPolicy, ...runtimeOptions } = options ?? {};
    const toolSession = context.kind === "tool-session";
    const authoredCreateOptions = {
      ...createOptions,
      ...runtimeOptions,
      ...(networkPolicy === undefined
        ? {}
        : { networkPolicy: toVercelNetworkPolicy(networkPolicy) }),
      env: { ...SANDBOX_AGENT_ENV, ...(runtimeOptions.env ?? createOptions.env) },
    };
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
      mounts: mounts === undefined ? undefined : toVercelMounts(mounts),
      sandboxModule,
      sessionKey: sandboxName,
      snapshotId: artifact.snapshotId,
      tags,
    };
    try {
      const session = await ensureUsableSession({
        expired: toolSession ? isVercelSnapshotNotFoundError : isVercelSnapshotUnavailableError,
        inheritsBaseRuntime:
          artifact.snapshotId !== undefined && mounts === undefined && usesEveBase,
        input: ensureSessionInput,
        session: await ensureSession(ensureSessionInput),
      });
      return session.sandbox;
    } catch (error) {
      if (isVercelSnapshotUnavailableError(error) && artifact.snapshotId !== undefined) {
        throw new SandboxTemplateNotProvisionedError({
          providerName: "vercel",
          reason: "The Vercel Sandbox snapshot expired or was deleted.",
          templateKey: artifact.snapshotId,
        });
      }
      throw new Error(
        `Failed to open Vercel sandbox session "${context.session.id}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function vercelSessionName(sessionId: string): string {
  return `eve-sbx-vercel-${createSandboxProviderIdentity({ sessionId, version: 2 }).slice(0, 32)}`;
}

function vercelIdentityOptions(options: object | undefined): object | undefined {
  if (options === undefined) return undefined;
  const excluded = new Set(["fetch", "projectId", "signal", "teamId", "token"]);
  return Object.fromEntries(Object.entries(options).filter(([key]) => !excluded.has(key)));
}

function requireVercelSessionState(state: SandboxJson): VercelSandboxSessionState {
  if (!isObject(state) || state.version !== 3 || typeof state.sandboxName !== "string") {
    throw invalidSandboxSessionStateError("Vercel sandbox");
  }
  return { sandboxName: state.sandboxName, version: 3 };
}

function requirePreparedVercelTemplate(artifact: SandboxJson): VercelSandboxPreparedArtifact {
  if (
    !isObject(artifact) ||
    (artifact.snapshotId !== undefined && typeof artifact.snapshotId !== "string")
  ) {
    throw invalidPreparedSandboxArtifactError("Vercel sandbox");
  }
  return artifact.snapshotId === undefined ? {} : { snapshotId: artifact.snapshotId };
}

function toVercelMounts(
  mounts: VercelSandboxMounts,
): Record<string, { readonly drive: string; readonly mode: VercelSandboxMountMode }> {
  return Object.fromEntries(
    Object.entries(mounts).map(([path, mount]) => [
      path,
      "mode" in mount
        ? { drive: mount.drive, mode: mount.mode }
        : { drive: mount.name, mode: "read-write" },
    ]),
  );
}

type ResolvedVercelCreateOptions = VercelCreateOptions & { readonly timeout: number };

interface EnsureTemplateInput {
  readonly context: SandboxPrepareContext;
  readonly createOptions: ResolvedVercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly templateKey: string;
}

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
    input.context.log("reusing prepared sandbox template");
    return publishedSnapshotId;
  }

  const snapshotId = await prepareTemplateSnapshot(input, sandboxModule);
  await publishTemplatePointer(input, sandboxModule, pointer, snapshotId).catch(
    (error: unknown) => {
      input.context.log(`could not publish sandbox template: ${errorMessage(error)}`);
    },
  );
  return snapshotId;
}

async function prepareTemplateSnapshot(
  input: EnsureTemplateInput,
  sandboxModule: VercelModule,
): Promise<string> {
  const sandbox = await input.createSandbox({
    sandboxModule,
    createOptions: withBaseSetupNetworkPolicy({
      ...input.createOptions,
      name: `${input.templateKey}-${randomBytes(4).toString("hex")}`,
      persistent: false,
    }),
  });
  try {
    input.context.log("preparing base runtime inside sandbox");
    await ensureVercelSandboxBaseRuntime(sandbox);
    await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);
    await input.context.populate(createVercelConnection(sandbox));
    await ensureVercelSandboxBaseRuntime(sandbox);
    return (await sandbox.snapshot()).snapshotId;
  } finally {
    await sandbox.delete().catch((error: unknown) => {
      input.context.log(`could not delete sandbox ${sandbox.name}: ${errorMessage(error)}`);
    });
  }
}

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
      if (!isVercelSandboxMissingError(error)) throw error;
    }
  }
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
  readonly mounts?: ReturnType<typeof toVercelMounts>;
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
  readonly inheritsBaseRuntime: boolean;
  readonly input: EnsureSessionInput;
  readonly session: VercelSandboxSessionCreateResult;
}): Promise<VercelSandboxSessionCreateResult> {
  const ensureBaseRuntime = async (session: VercelSandboxSessionCreateResult) => {
    if (session.created && input.inheritsBaseRuntime) return;
    await ensureVercelSandboxBaseRuntime(session.sandbox);
  };
  try {
    await ensureBaseRuntime(input.session);
    return input.session;
  } catch (error) {
    if (input.session.created || !input.expired(error)) {
      throw error;
    }
  }

  try {
    await deleteUnusableVercelSandbox({
      createOptions: input.input.createOptions,
      sandboxModule: input.input.sandboxModule,
      sandboxName: input.session.sandbox.name,
    });
  } catch (error) {
    if (!isVercelSandboxMissingError(error)) throw error;
  }
  const replacement = await ensureSession(input.input);
  await ensureBaseRuntime(replacement);
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

  const createParams = createSessionCreateParams(input, sandboxName);
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
    if (!isVercelSandboxNameConflictError(error)) throw error;
    const winner = await getNamedVercelSandbox({ ...input, sandboxName });
    if (winner === null) throw error;
    return { created: false, sandbox: winner };
  }
}

function createSessionCreateParams(
  input: EnsureSessionInput,
  sandboxName: string,
): VercelSandboxCreateParams {
  const createOptions: VercelCreateOptions = { ...input.createOptions };
  if (input.mounts !== undefined) createOptions.mounts = input.mounts;
  if (input.snapshotId === undefined) {
    return {
      ...createOptions,
      name: sandboxName,
      persistent: true,
    };
  }

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

function createVercelConnection(
  sandbox: VercelSandbox,
  commands: Pick<VercelSandbox, "runCommand"> = sandbox,
): SandboxConnection<VercelSandboxExtensions> {
  const deadline = createVercelDeadline(sandbox);
  return {
    extensions: {
      name: sandbox.name,
      setNetworkPolicy: createVercelNetworkPolicySetter(sandbox),
    },
    async readFile(options) {
      await deadline.renew();
      return normalizeVercelReadStream(await sandbox.readFile({ path: options.path }));
    },
    async removePath(options: SandboxRemovePathOptions) {
      await deadline.renew();
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.signal,
      });
    },
    async spawn(options): Promise<SandboxProcess> {
      await deadline.renew();
      const command = await commands.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory,
        detached: true,
        env: options.env,
        signal: options.signal,
        stdin: options.stdin,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        abortSignal: options.signal,
        command,
        getOutput: (log) => log.stream,
        stdin: options.stdin === true ? command : undefined,
      });
    },
    async stop() {
      await stopVercelSandbox(sandbox);
    },
    async writeFiles(options: SandboxWriteFilesOptions) {
      if (options.files.length === 0) return;
      await deadline.renew();
      await sandbox.writeFiles(
        await resolveVercelWriteFiles(sandbox, options.files, options.signal),
        {
          signal: options.signal,
        },
      );
    },
  };
}

const REALPATH_ARGUMENT_BYTES = 64 * 1024;

async function resolveVercelWriteFiles(
  sandbox: VercelSandbox,
  files: SandboxWriteFilesOptions["files"],
  signal?: AbortSignal,
): Promise<{ content: Uint8Array; path: string }[]> {
  const paths: string[] = [];
  let batch: string[] = [];
  let batchBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.path) + 1;
    if (batch.length > 0 && batchBytes + bytes > REALPATH_ARGUMENT_BYTES) {
      paths.push(...(await resolveVercelPaths(sandbox, batch, signal)));
      batch = [];
      batchBytes = 0;
    }
    batch.push(file.path);
    batchBytes += bytes;
  }
  paths.push(...(await resolveVercelPaths(sandbox, batch, signal)));
  return files.map((file, index) => {
    const path = paths[index];
    if (path === undefined || !path.startsWith("/")) {
      throw new Error(`Failed to resolve Vercel Sandbox write path: ${file.path}`);
    }
    return { content: file.content, path };
  });
}

async function resolveVercelPaths(
  sandbox: VercelSandbox,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await sandbox.runCommand({
    args: ["-m", "-z", "--", ...paths],
    cmd: "realpath",
    signal,
  });
  if (result.exitCode !== 0) {
    const stderr = (await result.stderr()).trim();
    throw new Error(`Failed to resolve Vercel Sandbox write paths with realpath: ${stderr}`);
  }
  const resolved = (await result.stdout()).split("\0").slice(0, -1);
  if (resolved.length !== paths.length) {
    throw new Error(
      `Failed to resolve Vercel Sandbox write paths: realpath printed ${resolved.length} paths for ${paths.length} files.`,
    );
  }
  return resolved;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
