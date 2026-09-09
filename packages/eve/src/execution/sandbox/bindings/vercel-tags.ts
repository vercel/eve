import type { SandboxBackendTags } from "#public/definitions/sandbox-backend.js";
import type {
  VercelCreateOptions,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

const VERCEL_SANDBOX_TAG_LIMIT = 5;

/**
 * Merges author-supplied tags with eve's reserved tags into the flat
 * `Record<string, string>` the Vercel SDK expects, or `undefined` when
 * there are none. Throws if the merged set exceeds Vercel's tag limit.
 */
export function resolveVercelSandboxTags(
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

/**
 * Applies `tags` to an existing sandbox, skipping the network update when
 * they already match.
 */
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
