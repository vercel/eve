import { createLogger } from "#internal/logging.js";
import type {
  VercelSandboxSessionCreateContext,
  VercelSandboxSessionCreateOptions,
} from "#public/sandbox/vercel-sandbox.js";
import type {
  CreateVercelSandbox,
  VercelSandboxCreateParams,
} from "#execution/sandbox/bindings/vercel-create-sdk.js";
import {
  isVercelSandboxMissingError,
  isVercelSnapshotNotFoundError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

const logger = createLogger("sandbox.vercel");

export type ResolveVercelSessionCreateOptions = (
  context: VercelSandboxSessionCreateContext,
) => Promise<VercelSandboxSessionCreateOptions> | VercelSandboxSessionCreateOptions;

export interface EnsureSessionInput {
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly existingMetadata?: Record<string, unknown>;
  readonly resolveSessionCreateOptions?: ResolveVercelSessionCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly snapshotId?: string;
  readonly tags: Record<string, string> | undefined;
}

export interface VercelSandboxSessionCreateResult {
  readonly created: boolean;
  readonly sandbox: VercelSandbox;
}

export class VercelTemplateSnapshotUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("template snapshot unavailable during session create", options);
  }

  static is(error: unknown): error is VercelTemplateSnapshotUnavailableError {
    return error instanceof VercelTemplateSnapshotUnavailableError;
  }
}

export async function ensureSession(
  input: EnsureSessionInput,
): Promise<VercelSandboxSessionCreateResult> {
  const sandboxName = getVercelSandboxName(input.existingMetadata) ?? input.sessionKey;
  let existing: VercelSandbox | null;
  try {
    existing = await getNamedVercelSandbox({
      createOptions: input.createOptions,
      resume: true,
      sandboxModule: input.sandboxModule,
      sandboxName,
    });
  } catch (error) {
    if (!isVercelSnapshotNotFoundError(error)) {
      throw error;
    }

    // The backing snapshot expired, so the persisted filesystem is already
    // unrecoverable. Delete-then-recreate under the same name mirrors the
    // SDK's own `Sandbox.getOrCreate` recovery; concurrent creates for one
    // session key share its race window and surface a name conflict to the
    // loser.
    logger.warn("session sandbox snapshot expired; deleting it and creating a replacement", {
      sandboxName,
    });
    const stale = await getNamedVercelSandbox({
      createOptions: input.createOptions,
      sandboxModule: input.sandboxModule,
      sandboxName,
    });
    try {
      await stale?.delete();
    } catch (deleteError) {
      if (!isVercelSandboxMissingError(deleteError)) {
        throw deleteError;
      }
    }
    existing = null;
  }

  if (existing !== null) {
    await ensureVercelSandboxTags(existing, input.tags);
    return { created: false, sandbox: existing };
  }

  const sessionCreateOptions = await input.resolveSessionCreateOptions?.({
    session: { id: input.sessionId },
  });
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
    if (
      input.snapshotId !== undefined &&
      (isVercelSnapshotUnavailableError(error) || isVercelSandboxMissingError(error))
    ) {
      throw new VercelTemplateSnapshotUnavailableError({ cause: error });
    }
    throw error;
  }
}

function createSessionCreateParams(
  input: EnsureSessionInput,
  sandboxName: string,
  sessionCreateOptions: VercelSandboxSessionCreateOptions = {},
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

function getVercelSandboxName(metadata: Record<string, unknown> | undefined): string | undefined {
  const sandboxName = metadata?.sandboxName;
  return typeof sandboxName === "string" ? sandboxName : undefined;
}

/*
 * Shared with the template lifecycle in vercel.ts: templates and sessions
 * apply the same tag reconciliation, and both fresh-create paths start
 * permissive so framework base setup runs before the author's network
 * policy applies.
 */
export function withBaseSetupNetworkPolicy(
  createOptions: VercelSandboxCreateParams,
): VercelSandboxCreateParams {
  return { ...createOptions, networkPolicy: "allow-all" };
}

export async function ensureVercelSandboxTags(
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
