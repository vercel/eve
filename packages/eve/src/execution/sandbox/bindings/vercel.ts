import {
  applyInitialVercelNetworkPolicy,
  ensureVercelSandboxBaseRuntime,
} from "#execution/sandbox/bindings/vercel-base-runtime.js";
import type { SandboxBootstrapContext } from "#public/definitions/sandbox.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
  SandboxBackendTags,
  SandboxSeedFile,
} from "#public/definitions/sandbox-backend.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import type {
  VercelSandboxBootstrapUseOptions,
  VercelSandboxSessionUseOptions,
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
  isVercelSandboxMissingError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-backend-utils.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export interface CreateVercelSandboxInput {
  readonly createSandbox?: CreateVercelSandbox;
  readonly createOptions?: VercelCreateOptions;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
}
/**
 * Creates the Vercel-backed sandbox backend.
 *
 * Any author-supplied `createOptions` are forwarded to Vercel's sandbox
 * create API for every fresh sandbox the framework creates (template at
 * prewarm time, session at first-time session-create). On resume
 * (`Sandbox.get`) no create happens, so they are not re-applied.
 */
export function createVercelSandbox(
  input: CreateVercelSandboxInput = {},
): SandboxBackend<VercelSandboxBootstrapUseOptions, VercelSandboxSessionUseOptions> {
  const loadSandboxModule =
    input.loadSandboxModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...input.createOptions,
  };
  const createSandbox = input.createSandbox ?? createVercelEveImageSandbox;
  const prewarmedTemplates = new Map<string, VercelSandboxTemplateRecord>();

  return {
    name: "vercel",
    async create(
      createInput: SandboxBackendCreateInput,
    ): Promise<SandboxBackendHandle<VercelSandboxSessionUseOptions>> {
      // Resolve tags up-front so tag-count validation fails fast before
      // we go to the network for the template snapshot.
      const tags = resolveVercelSandboxTags(createOptions.tags, createInput.tags);

      const template =
        createInput.templateKey === null
          ? null
          : await readTemplateForCreate({
              createOptions,
              loadSandboxModule,
              prewarmedTemplates,
              templateKey: createInput.templateKey,
            });

      const sandboxModule = await loadSandboxModule();
      let session: VercelSandboxSessionCreateResult;
      try {
        session = await ensureSession({
          createOptions,
          createSandbox,
          existingMetadata: createInput.existingMetadata,
          sandboxModule,
          sessionKey: createInput.sessionKey,
          snapshotId: template?.snapshotId,
          tags,
        });
      } catch (error) {
        if (
          template !== null &&
          (isVercelSnapshotUnavailableError(error) || isVercelSandboxMissingError(error))
        ) {
          prewarmedTemplates.delete(template.templateKey);
          const staleTemplate = await getNamedVercelSandbox({
            createOptions,
            sandboxModule,
            sandboxName: template.sandboxName,
          });
          await staleTemplate?.delete();
          throw new SandboxTemplateNotProvisionedError({
            backendName: "vercel",
            templateKey: template.templateKey,
          });
        }
        throw new Error(
          `Failed to create sandbox session "${createInput.sessionKey}": ${errorMessage(error)}`,
          { cause: error },
        );
      }

      if (template === null && session.created) {
        await ensureVercelSandboxBaseRuntime(session.sandbox);
        await applyInitialVercelNetworkPolicy(session.sandbox, createOptions.networkPolicy);
      }

      return createHandle(session.sandbox, createInput.sessionKey);
    },
    async prewarm(
      prewarmInput: SandboxBackendPrewarmInput<VercelSandboxBootstrapUseOptions>,
    ): Promise<SandboxBackendPrewarmResult> {
      let outcome: EnsureTemplateOutcome;
      try {
        outcome = await ensureTemplateWithUnavailableRetry({
          bootstrap: prewarmInput.bootstrap,
          createOptions,
          createSandbox,
          loadSandboxModule,
          log: prewarmInput.log,
          seedFiles: prewarmInput.seedFiles,
          templateKey: prewarmInput.templateKey,
        });
      } catch (error) {
        throw new Error(
          `Failed to prewarm Vercel sandbox template "${prewarmInput.templateKey}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
      prewarmedTemplates.set(prewarmInput.templateKey, outcome.template);
      return { reused: outcome.reused };
    },
  };
}

interface VercelSandboxTemplateRecord {
  readonly sandboxName: string;
  readonly snapshotId: string;
  readonly templateKey: string;
}

interface EnsureTemplateOutcome {
  readonly reused: boolean;
  readonly template: VercelSandboxTemplateRecord;
}

interface EnsureTemplateInput {
  readonly bootstrap?: (
    input: SandboxBootstrapContext<VercelSandboxBootstrapUseOptions>,
  ) => void | Promise<void>;
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<SandboxSeedFile>;
  readonly tags?: SandboxBackendTags;
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

async function readTemplate(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly prewarmedTemplates: ReadonlyMap<string, VercelSandboxTemplateRecord>;
  readonly templateKey: string;
}): Promise<VercelSandboxTemplateRecord> {
  const prewarmed = input.prewarmedTemplates.get(input.templateKey);
  if (prewarmed !== undefined) {
    return prewarmed;
  }

  const sandboxModule = await input.loadSandboxModule();
  const sandbox = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule,
    sandboxName: input.templateKey,
  });

  if (sandbox === null || typeof sandbox.currentSnapshotId !== "string") {
    throw new SandboxTemplateNotProvisionedError({
      backendName: "vercel",
      templateKey: input.templateKey,
    });
  }

  return {
    sandboxName: sandbox.name,
    snapshotId: sandbox.currentSnapshotId,
    templateKey: input.templateKey,
  };
}

async function readTemplateForCreate(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly prewarmedTemplates: ReadonlyMap<string, VercelSandboxTemplateRecord>;
  readonly templateKey: string;
}): Promise<VercelSandboxTemplateRecord> {
  try {
    return await readTemplate(input);
  } catch (error) {
    if (SandboxTemplateNotProvisionedError.is(error)) {
      throw error;
    }
    throw new Error(
      `Failed to read sandbox template "${input.templateKey}": ${errorMessage(error)}`,
      { cause: error },
    );
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
        persistent: false,
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
   * bootstrap, seed file writes, and `sandbox.snapshot()` on top.
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

  if (input.bootstrap !== undefined) {
    input.log?.("running sandbox bootstrap");
    await input.bootstrap({
      use: async (options?: VercelSandboxBootstrapUseOptions) => {
        if (options !== undefined) {
          await sandbox.update(options);
        }
        return createLoggingSandboxSession({
          log: input.log,
          session: templateSession,
        });
      },
    });
  }

  await writeSandboxSeedFiles(templateSession, input.seedFiles);

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
  readonly sandboxModule: VercelModule;
  readonly sessionKey: string;
  readonly snapshotId?: string;
  readonly tags: Record<string, string> | undefined;
}

interface VercelSandboxSessionCreateResult {
  readonly created: boolean;
  readonly sandbox: VercelSandbox;
}

async function ensureSession(input: EnsureSessionInput): Promise<VercelSandboxSessionCreateResult> {
  const sandboxName = getVercelSandboxName(input.existingMetadata) ?? input.sessionKey;
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
): VercelSandboxCreateParams {
  if (input.snapshotId === undefined) {
    return withBaseSetupNetworkPolicy({
      ...input.createOptions,
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
    ...sessionCreateOptions
  } = input.createOptions as VercelCreateOptions &
    Partial<Record<"image" | "runtime" | "source", unknown>>;

  return {
    ...sessionCreateOptions,
    name: sandboxName,
    persistent: true,
    source: { snapshotId: input.snapshotId, type: "snapshot" as const },
  };
}

function withBaseSetupNetworkPolicy(
  createOptions: VercelSandboxCreateParams,
): VercelSandboxCreateParams {
  return { ...createOptions, networkPolicy: "allow-all" };
}

function createHandle(
  sandbox: VercelSandbox,
  sessionKey: string,
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  return {
    session: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey),
      createVercelNetworkPolicySetter(sandbox),
    ),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        await sandbox.update(options);
      }
      return buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, sessionKey),
        createVercelNetworkPolicySetter(sandbox),
      );
    },
    async captureState() {
      return {
        backendName: "vercel",
        metadata: { sandboxName: sandbox.name },
        sessionKey,
      };
    },
    // Session sandboxes are persistent, so the SDK resumes a stopped
    // sandbox on the next command after reattach.
    async shutdown() {
      await stopVercelSandbox(sandbox);
    },
  };
}

async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  try {
    await sandbox.stop();
  } catch {
    // Best-effort: an unreachable or already-stopped sandbox must not
    // block server shutdown; the provider-side timeout is the backstop.
  }
}

function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    await sandbox.update({ networkPolicy: policy });
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
      await sandbox.writeFiles([{ content: bytes, path: options.path }]);
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

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
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

function resolveVercelSandboxTags(
  userTags: VercelCreateOptions["tags"],
  eveTags: SandboxBackendTags | undefined,
): Record<string, string> | undefined {
  const tags: Record<string, string> = {};

  if (userTags !== undefined) {
    for (const [key, value] of Object.entries(userTags as Record<string, string>)) {
      tags[key] = value;
    }
  }

  if (eveTags !== undefined) {
    for (const [key, value] of Object.entries(eveTags)) {
      tags[key] = value;
    }
  }

  const count = Object.keys(tags).length;
  if (count === 0) {
    return undefined;
  }

  if (count > VERCEL_SANDBOX_TAG_LIMIT) {
    throw new Error(
      `Vercel Sandbox supports at most ${VERCEL_SANDBOX_TAG_LIMIT} tags. ` +
        'eve reserves "agent", "channel", and "sessionId"; remove or consolidate custom tags passed to vercel().',
    );
  }

  return tags;
}

async function ensureVercelSandboxTags(
  sandbox: VercelSandbox,
  tags: Record<string, string> | undefined,
): Promise<void> {
  if (tags === undefined || areVercelSandboxTagsEqual(sandbox.tags, tags)) {
    return;
  }

  await sandbox.update({ tags });
}

function areVercelSandboxTagsEqual(
  current: Record<string, string> | undefined,
  next: Record<string, string>,
): boolean {
  const currentTags = current ?? {};
  const currentEntries = Object.entries(currentTags);
  const nextEntries = Object.entries(next);

  if (currentEntries.length !== nextEntries.length) {
    return false;
  }

  return nextEntries.every(([key, value]) => currentTags[key] === value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseJson = (error as { readonly json?: unknown }).json;
    const responseText = (error as { readonly text?: unknown }).text;
    const responseBody =
      typeof responseText === "string" && responseText.length > 0
        ? responseText
        : responseJson !== undefined
          ? JSON.stringify(responseJson)
          : undefined;
    if (responseBody !== undefined) {
      return `${error.message}: ${responseBody}`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * 30 minutes. The `@vercel/sandbox` SDK defaults to 5 minutes which is
 * too short for multi-step workflows — the VM expires between steps.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;

const VERCEL_SANDBOX_TAG_LIMIT = 5;
