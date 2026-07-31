import {
  applyInitialVercelNetworkPolicy,
  ensureVercelSandboxBaseRuntime,
} from "#execution/sandbox/bindings/vercel-base-runtime.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-errors.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
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
import {
  createVercelInternalSandboxSession,
  createVercelNetworkPolicySetter,
  createVercelSandboxSession,
  stopVercelSandbox,
} from "#execution/sandbox/bindings/vercel-session.js";
import type { VercelModule, VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-options.js";
import type {
  VercelSandboxCreateOptions,
  VercelSandboxSessionOptions,
} from "#public/sandbox/vercel-sandbox.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { SandboxProviderContext } from "#shared/sandbox-value.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface VercelSandboxDependencies {
  readonly createSandbox?: CreateVercelSandbox;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
}

export interface VercelSandboxResource {
  readonly configuration: JsonObject;
  readonly sandbox: VercelSandbox;
  readonly session: SandboxSession;
  readonly sessionKey: string;
}

export interface VercelSandboxReference extends JsonObject {
  readonly configuration: JsonObject;
  readonly createdAt: string;
  readonly name: string;
  readonly sessionKey: string;
}

export interface VercelSandboxTemplateReference extends JsonObject {
  readonly sandboxName: string;
  readonly snapshotId: string;
  readonly templateKey: string;
}

export async function createVercelSandboxResource(input: {
  readonly context: SandboxProviderContext;
  readonly dependencies?: VercelSandboxDependencies;
  readonly name?: string;
  readonly options?: VercelSandboxCreateOptions;
  readonly sessionOptions?: VercelSandboxSessionOptions;
  readonly template?: VercelSandboxTemplateReference;
}): Promise<VercelSandboxResource> {
  const loadSandboxModule =
    input.dependencies?.loadSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...input.options,
    ...input.sessionOptions,
    signal: input.context.signal,
  };
  const configuration = createVercelRestorationConfiguration(createOptions);
  const createSandbox = input.dependencies?.createSandbox ?? createVercelEveImageSandbox;
  const sandboxModule = await loadSandboxModule();
  const sessionKey = input.name ?? input.context.resourceId;
  const tags = resolveVercelSandboxTags(createOptions.tags, input.context.tags);
  let session: VercelSandboxSessionCreateResult;
  try {
    session = await ensureSession({
      createOptions,
      createSandbox,
      sandboxModule,
      sessionKey,
      snapshotId: input.template?.snapshotId,
      tags,
    });
  } catch (error) {
    if (
      input.template !== undefined &&
      (isVercelSnapshotUnavailableError(error) || isVercelSandboxMissingError(error))
    ) {
      try {
        const staleTemplate = await getNamedVercelSandbox({
          createOptions,
          sandboxModule,
          sandboxName: input.template.sandboxName,
        });
        await staleTemplate?.delete();
      } catch {
        // Cleanup failure must not replace the retryable template error.
      }
      throw new SandboxTemplateUnavailableError({
        provider: "vercel",
        templateKey: input.template.templateKey,
      });
    }
    throw new Error(`Failed to create sandbox session "${sessionKey}": ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (input.template === undefined && session.created) {
    await ensureVercelSandboxBaseRuntime(session.sandbox);
    await applyInitialVercelNetworkPolicy(session.sandbox, createOptions.networkPolicy);
  }

  return createVercelResource(session.sandbox, sessionKey, configuration);
}

/** Rejects replaced resources instead of silently attaching persisted state to them. */
export async function restoreVercelSandboxResource(
  reference: VercelSandboxReference,
  context: SandboxProviderContext,
  dependencies: VercelSandboxDependencies = {},
): Promise<VercelSandboxResource> {
  const loadSandboxModule =
    dependencies.loadSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    ...readVercelRestorationOptions(reference.configuration),
    signal: context.signal,
  };
  const sandboxModule = await loadSandboxModule();
  const sandbox = await getNamedVercelSandbox({
    createOptions,
    sandboxModule,
    sandboxName: reference.name,
  });
  if (sandbox === null || sandbox.createdAt.toISOString() !== reference.createdAt) {
    throw new SandboxResourceUnavailableError({
      provider: "vercel",
      sessionKey: reference.name,
    });
  }
  await ensureVercelSandboxTags(
    sandbox,
    context.tags === undefined
      ? undefined
      : resolveVercelSandboxTags(createOptions.tags, context.tags),
  );
  return createVercelResource(sandbox, reference.sessionKey, reference.configuration);
}

export function referenceVercelSandboxResource(
  resource: VercelSandboxResource,
): VercelSandboxReference {
  return {
    configuration: resource.configuration,
    createdAt: resource.sandbox.createdAt.toISOString(),
    name: resource.sandbox.name,
    sessionKey: resource.sessionKey,
  };
}

export async function shutdownVercelSandboxResource(
  resource: VercelSandboxResource,
): Promise<void> {
  await stopVercelSandbox(resource.sandbox);
}

export async function prewarmVercelSandboxTemplate(input: {
  readonly dependencies?: VercelSandboxDependencies;
  readonly log?: (message: string) => void;
  readonly options?: VercelSandboxCreateOptions;
  readonly prepare: (resource: VercelSandboxResource) => Promise<void>;
  readonly templateId: string;
}): Promise<VercelSandboxTemplateReference> {
  const loadSandboxModule =
    input.dependencies?.loadSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...input.options,
  };
  try {
    return (
      await ensureTemplateWithUnavailableRetry({
        prepare: input.prepare,
        createOptions,
        createSandbox: input.dependencies?.createSandbox ?? createVercelEveImageSandbox,
        loadSandboxModule,
        log: input.log,
        templateKey: input.templateId,
      })
    ).template;
  } catch (error) {
    throw new Error(
      `Failed to prewarm Vercel sandbox template "${input.templateId}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

interface EnsureTemplateOutcome {
  readonly reused: boolean;
  readonly template: VercelSandboxTemplateReference;
}

interface EnsureTemplateInput {
  readonly prepare: (resource: VercelSandboxResource) => Promise<void>;
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly log?: (message: string) => void;
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

async function ensureTemplate(input: EnsureTemplateInput): Promise<EnsureTemplateOutcome> {
  const sandboxModule = await input.loadSandboxModule();
  let sandbox = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule,
    sandboxName: input.templateKey,
  });
  const tags = resolveVercelSandboxTags(input.createOptions.tags, undefined);
  const authorSnapshotId = extractAuthorSnapshotId(input.createOptions);

  if (
    sandbox !== null &&
    hasFrameworkSnapshot(sandbox, authorSnapshotId) &&
    !hasImmutableTemplateBase(input.createOptions)
  ) {
    input.log?.("template base is not immutable; rebuilding sandbox template");
    await sandbox.delete();
    sandbox = null;
  }

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

  // A snapshot source initially reports the author's base as current. Only a
  // different snapshot proves eve completed hydration and preparation.
  if (hasFrameworkSnapshot(sandbox, authorSnapshotId)) {
    return {
      reused: true,
      template: {
        sandboxName: sandbox.name,
        snapshotId: sandbox.currentSnapshotId,
        templateKey: input.templateKey,
      },
    };
  }

  try {
    input.log?.("preparing base runtime inside sandbox");
    await ensureVercelSandboxBaseRuntime(sandbox);
    await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);

    const templateSession = createLoggingSandboxSession({
      log: input.log,
      session: buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, input.templateKey),
        createVercelNetworkPolicySetter(sandbox),
      ),
    });

    input.log?.("running template preparation");
    await input.prepare(
      createVercelResource(
        sandbox,
        input.templateKey,
        createVercelRestorationConfiguration(input.createOptions),
        templateSession,
      ),
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
  } catch (error) {
    await sandbox.delete().catch(() => {});
    throw error;
  }
}

interface EnsureSessionInput {
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
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

  const baseCreateParams = createSessionCreateParams(input, sandboxName);
  const createParams: VercelSandboxCreateParams =
    input.tags === undefined ? baseCreateParams : { ...baseCreateParams, tags: input.tags };

  try {
    return {
      created: true,
      sandbox: await input.createSandbox({
        createOptions: createParams,
        sandboxModule: input.sandboxModule,
      }),
    };
  } catch (error) {
    const raced = await getNamedVercelSandbox({
      createOptions: createParams,
      sandboxModule: input.sandboxModule,
      sandboxName,
    });
    if (raced !== null) {
      await ensureVercelSandboxTags(raced, input.tags);
      return { created: false, sandbox: raced };
    }
    throw error;
  }
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

  // The template snapshot owns the base; session creation cannot replace it.
  const {
    image: _image,
    runtime: _runtime,
    source: _source,
    ...sessionCreateOptions
  } = input.createOptions;

  return {
    ...sessionCreateOptions,
    name: sandboxName,
    persistent: true,
    source: { snapshotId: input.snapshotId, type: "snapshot" },
  };
}

function withBaseSetupNetworkPolicy(
  createOptions: VercelSandboxCreateParams,
): VercelSandboxCreateParams {
  return { ...createOptions, networkPolicy: "allow-all" };
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

function extractAuthorSnapshotId(createOptions: VercelCreateOptions): string | undefined {
  return createOptions.source?.type === "snapshot" ? createOptions.source.snapshotId : undefined;
}

function hasFrameworkSnapshot(
  sandbox: VercelSandbox,
  authorSnapshotId: string | undefined,
): sandbox is VercelSandbox & { readonly currentSnapshotId: string } {
  return (
    typeof sandbox.currentSnapshotId === "string" &&
    sandbox.currentSnapshotId.length > 0 &&
    sandbox.currentSnapshotId !== authorSnapshotId
  );
}

function hasImmutableTemplateBase(createOptions: VercelCreateOptions): boolean {
  const { image, source } = createOptions;

  if (source === undefined && image === undefined) {
    return false;
  }

  if (source?.type === "snapshot" && typeof source.snapshotId === "string") {
    return true;
  }
  if (
    source?.type === "git" &&
    typeof source.revision === "string" &&
    /^[a-f0-9]{40}$/i.test(source.revision)
  ) {
    return true;
  }

  return typeof image === "string" && /@sha256:[a-f0-9]{64}$/i.test(image);
}

function createVercelRestorationConfiguration(createOptions: VercelCreateOptions): JsonObject {
  const projectId = readNonEmptyString(createOptions.projectId);
  const teamId = readNonEmptyString(createOptions.teamId);
  const configuration: Record<string, JsonValue> = {};
  if (projectId !== undefined) {
    configuration.projectId = projectId;
  }
  if (teamId !== undefined) {
    configuration.teamId = teamId;
  }
  if (createOptions.tags !== undefined) {
    configuration.tags = { ...createOptions.tags };
  }
  return configuration;
}

function readVercelRestorationOptions(configuration: JsonObject): VercelSandboxSessionOptions {
  const projectId = readNonEmptyString(configuration.projectId);
  const teamId = readNonEmptyString(configuration.teamId);
  const tags = readStringRecord(configuration.tags);
  const options: {
    projectId?: string;
    tags?: Record<string, string>;
    teamId?: string;
  } = {};
  if (projectId !== undefined) {
    options.projectId = projectId;
  }
  if (teamId !== undefined) {
    options.teamId = teamId;
  }
  if (tags !== undefined) {
    options.tags = tags;
  }
  return options;
}

function readNonEmptyString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function createVercelResource(
  sandbox: VercelSandbox,
  sessionKey: string,
  configuration: JsonObject,
  session = createVercelSandboxSession(sandbox, sessionKey),
): VercelSandboxResource {
  return {
    configuration,
    sandbox,
    session,
    sessionKey,
  };
}

function resolveVercelSandboxTags(
  userTags: VercelCreateOptions["tags"],
  eveTags: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  const tags: Record<string, string> = {};

  if (userTags !== undefined) {
    for (const [key, value] of Object.entries(userTags)) {
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
        'eve reserves "agent", "channel", and "sessionId"; remove or consolidate custom VercelSandbox tags.',
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
    const responseJson = "json" in error ? error.json : undefined;
    const responseText = "text" in error ? error.text : undefined;
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

// The SDK's five-minute default can expire between durable workflow steps.
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;

const VERCEL_SANDBOX_TAG_LIMIT = 5;
