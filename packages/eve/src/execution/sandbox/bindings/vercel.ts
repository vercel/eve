import {
  sandboxConnectionDisposal,
  withSandboxConnectionDisposal,
} from "#execution/sandbox/connection-disposal.js";
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
import {
  isVercelSandboxMissingError,
  isVercelSandboxNameConflictError,
  isVercelSnapshotNotFoundError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import {
  deleteNamedVercelSandbox,
  deleteUnusableVercelSandbox,
  deleteVercelSnapshot,
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
import { createVercelTimeout } from "#execution/sandbox/bindings/vercel-timeout.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { withToolSessionRetention } from "#execution/sandbox/bindings/vercel-tool-sessions.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { createLogger } from "#internal/logging.js";
import {
  withSandboxTemplateRebuilder,
  type SandboxTemplateRebuilderInput,
  type SandboxTemplateRebuildResult,
} from "#sandbox/template-rebuild.js";
import { isObject } from "#shared/guards.js";
import {
  invalidPreparedSandboxArtifactError,
  invalidSandboxSessionStateError,
} from "#shared/sandbox-recorded-data-error.js";

export type VercelSandboxPreparedArtifact = {
  readonly snapshotId?: string;
  readonly templateKey?: string;
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
  readonly rebuildable?: boolean;
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

  const implementation: SandboxProviderImplementation<
    VercelSandboxRuntimeOptions,
    VercelSandboxPreparedArtifact,
    VercelSandboxSessionState,
    VercelSandboxExtensions
  > = {
    async onSessionEnd(context, state, { signal }) {
      await deleteNamedVercelSandbox({
        createOptions,
        sandboxModule: await loadSandboxModule(),
        sandboxName: state?.sandboxName ?? vercelSessionName(context.session.id),
        signal,
      });
    },
    async onSessionIdle(context, state, { signal }) {
      const sandbox = await getNamedVercelSandbox({
        createOptions: signal === undefined ? createOptions : { ...createOptions, signal },
        sandboxModule: await loadSandboxModule(),
        sandboxName: state?.sandboxName ?? vercelSessionName(context.session.id),
      });
      if (sandbox === null) return;
      try {
        await stopVercelSandbox(sandbox, signal);
      } catch (error) {
        if (!isVercelSandboxMissingError(error)) throw error;
      }
    },
    async prepare(context) {
      if (context.isEmpty && createOptions.source === undefined) return {};
      try {
        const templateKey = vercelTemplateKey(
          context,
          createOptions,
          image,
          input.rebuildable === true,
        );
        const snapshotId = await ensureTemplate({
          context,
          createOptions,
          createSandbox,
          loadSandboxModule,
          templateKey,
        });
        return input.rebuildable === true ? { snapshotId, templateKey } : { snapshotId };
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
  return withSandboxTemplateRebuilder(implementation, async (artifact, input) =>
    rebuildTemplate(
      { createOptions, createSandbox, loadSandboxModule },
      requirePreparedVercelTemplate(artifact),
      input,
    ),
  );

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
      snapshotIds: () =>
        resolveSessionSnapshotIds({
          artifact,
          createOptions: sessionCreateOptions,
          sandboxModule,
        }),
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

function vercelTemplateKey(
  context: Pick<SandboxPrepareContext, "templateKey">,
  createOptions: VercelCreateOptions,
  image: string,
  rebuildable: boolean,
): string {
  const excluded = new Set(["fetch", "projectId", "signal", "teamId", "token"]);
  const identityOptions = Object.fromEntries(
    Object.entries(createOptions).filter(([key]) => !excluded.has(key)),
  );
  const hash = context.templateKey({
    createOptions: identityOptions,
    resolvedImage: createOptions.source === undefined ? image : undefined,
    version: 4,
    vercelEnv: rebuildable
      ? process.env.VERCEL_TARGET_ENV?.trim() || process.env.VERCEL_ENV?.trim() || undefined
      : undefined,
  });
  return `eve-sbx-tpl-vercel-${hash.slice(0, 32)}`;
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
    (artifact.snapshotId !== undefined && typeof artifact.snapshotId !== "string") ||
    (artifact.templateKey !== undefined && typeof artifact.templateKey !== "string")
  ) {
    throw invalidPreparedSandboxArtifactError("Vercel sandbox");
  }
  const prepared: { snapshotId?: string; templateKey?: string } = {};
  if (artifact.snapshotId !== undefined) prepared.snapshotId = artifact.snapshotId;
  if (artifact.templateKey !== undefined) prepared.templateKey = artifact.templateKey;
  return prepared;
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
  return await captureTemplateSnapshot({
    createOptions: input.createOptions,
    createSandbox: input.createSandbox,
    log: input.context.log,
    run: (connection) => input.context.populate(connection),
    sandboxModule,
    templateKey: input.templateKey,
  });
}

interface CaptureTemplateSnapshotInput {
  readonly createOptions: ResolvedVercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly log: (message: string) => void;
  readonly run: (connection: SandboxConnection<VercelSandboxExtensions>) => Promise<void>;
  readonly sandboxModule: VercelModule;
  readonly templateKey: string;
}

async function captureTemplateSnapshot(input: CaptureTemplateSnapshotInput): Promise<string> {
  const sandbox = await input.createSandbox({
    sandboxModule: input.sandboxModule,
    createOptions: withBaseSetupNetworkPolicy({
      ...input.createOptions,
      name: `${input.templateKey}-${randomBytes(4).toString("hex")}`,
      persistent: false,
    }),
  });
  try {
    input.log("preparing base runtime inside sandbox");
    await ensureVercelSandboxBaseRuntime(sandbox);
    await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);
    const connection = createVercelConnection(sandbox);
    try {
      await input.run(connection);
    } finally {
      await sandboxConnectionDisposal(connection)?.();
    }
    await ensureVercelSandboxBaseRuntime(sandbox);
    return (await sandbox.snapshot()).snapshotId;
  } finally {
    await sandbox.delete().catch((error: unknown) => {
      input.log(`could not delete sandbox ${sandbox.name}: ${errorMessage(error)}`);
    });
  }
}

async function publishTemplatePointer(
  input: Pick<EnsureTemplateInput, "createOptions" | "createSandbox" | "templateKey">,
  sandboxModule: VercelModule,
  stalePointer: VercelSandbox | null,
  snapshotId: string,
  revision?: string,
): Promise<boolean> {
  const previous =
    stalePointer?.sourceSnapshotId === undefined
      ? undefined
      : {
          revision: stalePointer.tags?.[TEMPLATE_REVISION_TAG],
          snapshotId: stalePointer.sourceSnapshotId,
        };
  if (stalePointer !== null) {
    try {
      await stalePointer.delete();
    } catch (error) {
      if (!isVercelSandboxMissingError(error)) throw error;
    }
  }
  try {
    return await createTemplatePointer(input, sandboxModule, snapshotId, revision);
  } catch (error) {
    if (previous !== undefined) {
      await createTemplatePointer(
        input,
        sandboxModule,
        previous.snapshotId,
        previous.revision,
      ).catch((restoreError: unknown) => {
        log.warn(
          `could not put back the previous sandbox template pointer: ${errorMessage(restoreError)}`,
        );
      });
    }
    throw error;
  }
}

async function createTemplatePointer(
  input: Pick<EnsureTemplateInput, "createOptions" | "createSandbox" | "templateKey">,
  sandboxModule: VercelModule,
  snapshotId: string,
  revision: string | undefined,
): Promise<boolean> {
  const {
    image: _image,
    runtime: _runtime,
    source: _source,
    ...createOptions
  } = input.createOptions;
  const pointerOptions: VercelSandboxCreateParams = {
    ...createOptions,
    name: input.templateKey,
    persistent: false,
    source: { snapshotId, type: "snapshot" },
  };
  const tags = resolveVercelSandboxTags(
    createOptions.tags,
    revision === undefined ? undefined : { [TEMPLATE_REVISION_TAG]: revision },
  );
  if (tags !== undefined) pointerOptions.tags = tags;
  let pointer: VercelSandbox;
  try {
    pointer = await input.createSandbox({ sandboxModule, createOptions: pointerOptions });
  } catch (error) {
    if (isVercelSandboxNameConflictError(error)) return false;
    throw error;
  }
  await stopVercelSandbox(pointer).catch((error: unknown) => {
    log.warn(
      `published the sandbox template but could not stop its pointer: ${errorMessage(error)}`,
    );
  });
  return true;
}

const TEMPLATE_REVISION_TAG = "eve-template-revision";

const log = createLogger("execution.sandbox.vercel");

const rebuildsInFlight = new Set<string>();

interface RebuildTemplateDependencies {
  readonly createOptions: ResolvedVercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
}

async function rebuildTemplate(
  dependencies: RebuildTemplateDependencies,
  artifact: VercelSandboxPreparedArtifact,
  input: SandboxTemplateRebuilderInput,
): Promise<SandboxTemplateRebuildResult> {
  const { templateKey } = artifact;
  if (artifact.snapshotId === undefined) {
    throw new Error(
      "This sandbox environment has no `prepare` callback, workspace files, skills or `source`, so the build captured no snapshot to rebuild. Add one of them, then run `eve build` again.",
    );
  }
  if (templateKey === undefined) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: "vercel",
      reason:
        "This build did not mark the sandbox rebuildable. Set `rebuildable: true` on the Vercel sandbox options, then run `eve build` again.",
      templateKey: artifact.snapshotId,
    });
  }
  if (rebuildsInFlight.has(templateKey)) return { rebuilt: false };
  rebuildsInFlight.add(templateKey);
  try {
    const sandboxModule = await dependencies.loadSandboxModule();
    const lookup = () =>
      getNamedVercelSandbox({
        createOptions: dependencies.createOptions,
        sandboxModule,
        sandboxName: templateKey,
      });
    const pointer = await lookup();
    if (
      pointer?.tags?.[TEMPLATE_REVISION_TAG] === input.revision &&
      pointer.sourceSnapshotId !== undefined &&
      (await isVercelSnapshotCreated({
        createOptions: dependencies.createOptions,
        sandboxModule,
        snapshotId: pointer.sourceSnapshotId,
      }))
    ) {
      return { rebuilt: false };
    }

    const baseSnapshotIds = templateSnapshotIds(artifact, pointer);
    const {
      image: _image,
      runtime: _runtime,
      source: _source,
      ...baseCreateOptions
    } = dependencies.createOptions;
    let snapshotId: string | undefined;
    for (const baseSnapshotId of baseSnapshotIds) {
      try {
        snapshotId = await captureTemplateSnapshot({
          createOptions: {
            ...baseCreateOptions,
            source: { snapshotId: baseSnapshotId, type: "snapshot" },
          },
          createSandbox: dependencies.createSandbox,
          log: (message) => log.info(message),
          run: input.prepare,
          sandboxModule,
          templateKey,
        });
        break;
      } catch (error) {
        if (!isVercelSnapshotUnavailableError(error)) throw error;
      }
    }
    if (snapshotId === undefined) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: "vercel",
        reason: "No snapshot of this template is available any more. Redeploy to rebuild it.",
        templateKey,
      });
    }

    const deleteSnapshot = (id: string) =>
      deleteVercelSnapshot({
        createOptions: dependencies.createOptions,
        sandboxModule,
        snapshotId: id,
      });
    let published: boolean;
    try {
      const current = await lookup();
      published =
        current?.sourceSnapshotId === pointer?.sourceSnapshotId &&
        (await publishTemplatePointer(
          { ...dependencies, templateKey },
          sandboxModule,
          current,
          snapshotId,
          input.revision,
        ));
    } catch (error) {
      await deleteSnapshot(snapshotId).catch(() => undefined);
      throw error;
    }
    if (!published) {
      await deleteSnapshot(snapshotId);
      return { rebuilt: false };
    }
    return { rebuilt: true };
  } finally {
    rebuildsInFlight.delete(templateKey);
  }
}

interface EnsureSessionInput {
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly mounts?: ReturnType<typeof toVercelMounts>;
  readonly sandboxModule: VercelModule;
  readonly sessionKey: string;
  readonly snapshotIds: () => Promise<readonly string[]>;
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

  const snapshotIds = await input.snapshotIds();
  const createFrom = async (snapshotId: string | undefined) => {
    const createParams = createSessionCreateParams(input, sandboxName, snapshotId);
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
  };
  for (const snapshotId of snapshotIds.slice(0, -1)) {
    try {
      return await createFrom(snapshotId);
    } catch (error) {
      if (!isVercelSnapshotUnavailableError(error)) throw error;
    }
  }
  return await createFrom(snapshotIds.at(-1));
}

async function resolveSessionSnapshotIds(input: {
  readonly artifact: VercelSandboxPreparedArtifact;
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
}): Promise<readonly string[]> {
  if (input.artifact.templateKey === undefined) return templateSnapshotIds(input.artifact, null);
  let pointer: VercelSandbox | null = null;
  try {
    pointer = await getNamedVercelSandbox({
      createOptions: input.createOptions,
      sandboxModule: input.sandboxModule,
      sandboxName: input.artifact.templateKey,
    });
  } catch (error) {
    log.warn(
      `could not read the sandbox template pointer, using the deployed snapshot: ${errorMessage(error)}`,
    );
  }
  return templateSnapshotIds(input.artifact, pointer);
}

function templateSnapshotIds(
  artifact: VercelSandboxPreparedArtifact,
  pointer: VercelSandbox | null,
): readonly string[] {
  const snapshotIds: string[] = [];
  if (pointer?.sourceSnapshotId !== undefined) snapshotIds.push(pointer.sourceSnapshotId);
  if (artifact.snapshotId !== undefined && !snapshotIds.includes(artifact.snapshotId)) {
    snapshotIds.push(artifact.snapshotId);
  }
  return snapshotIds;
}

function createSessionCreateParams(
  input: EnsureSessionInput,
  sandboxName: string,
  snapshotId: string | undefined,
): VercelSandboxCreateParams {
  const createOptions: VercelCreateOptions = { ...input.createOptions };
  if (input.mounts !== undefined) createOptions.mounts = input.mounts;
  if (snapshotId === undefined) {
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
    source: { snapshotId, type: "snapshot" },
  };
}

function createVercelConnection(
  sandbox: VercelSandbox,
): SandboxConnection<VercelSandboxExtensions> {
  let timeout: ReturnType<typeof createVercelTimeout> | undefined;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const activeTimeout = async () => {
    while (closing !== undefined) await closing;
    if (disposed)
      throw new Error(
        "This sandbox handle belongs to a finished execution scope. Call ctx.getSandbox() in the current scope.",
      );
    return (timeout ??= createVercelTimeout(sandbox));
  };
  const close = (stop = false): Promise<void> => {
    const next = Promise.resolve(closing)
      .catch(() => undefined)
      .then(async () => {
        const current = timeout;
        timeout = undefined;
        await current?.close();
        if (stop) await stopVercelSandbox(sandbox);
      })
      .finally(() => {
        if (closing === next) closing = undefined;
      });
    closing = next;
    return next;
  };
  const setNetworkPolicy = createVercelNetworkPolicySetter(sandbox);
  const connection: SandboxConnection<VercelSandboxExtensions> = {
    extensions: {
      name: sandbox.name,
      setNetworkPolicy: async (policy) =>
        (await activeTimeout()).run(() => setNetworkPolicy(policy)),
    },
    async readFile(options) {
      const release = await (await activeTimeout()).acquire(options.signal);
      try {
        return normalizeVercelReadStream(
          await sandbox.readFile({ path: options.path }, { signal: options.signal }),
          release,
        );
      } catch (error) {
        release();
        throw error;
      }
    },
    async removePath(options: SandboxRemovePathOptions) {
      await (
        await activeTimeout()
      ).run(
        () =>
          sandbox.fs.rm(options.path, {
            force: options.force,
            recursive: options.recursive,
            signal: options.signal,
          }),
        options.signal,
      );
    },
    async spawn(options): Promise<SandboxProcess> {
      const release = await (await activeTimeout()).acquire(options.signal);
      try {
        const command = await sandbox.runCommand({
          args: ["-lc", options.command],
          cmd: "bash",
          cwd: options.workingDirectory,
          detached: true,
          env: options.env,
          signal: options.signal,
          stdin: options.stdin,
        });
        const finished = command.wait({ signal: options.signal });
        void finished.then(release, release);
        return adaptMultiplexedCommandToSandboxProcess({
          abortSignal: options.signal,
          command: {
            async kill() {
              await command.kill();
              release();
            },
            logs: (opts) => command.logs(opts),
            wait: () => finished,
          },
          getOutput: (log) => log.stream,
          stdin: options.stdin === true ? command : undefined,
        });
      } catch (error) {
        release();
        throw error;
      }
    },
    stop: () => close(true),
    async writeFiles(options: SandboxWriteFilesOptions) {
      if (options.files.length === 0) return;
      await (
        await activeTimeout()
      ).run(async () => {
        await sandbox.writeFiles(
          await resolveVercelWriteFiles(sandbox, options.files, options.signal),
          { signal: options.signal },
        );
      }, options.signal);
    },
  };
  return withSandboxConnectionDisposal(connection, async () => {
    disposed = true;
    await close();
  });
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
