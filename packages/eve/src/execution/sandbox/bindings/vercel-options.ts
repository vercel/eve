import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxBackendTags } from "#public/definitions/sandbox-backend.js";

const VERCEL_SANDBOX_TAG_LIMIT = 5;

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
  if (count === 0) return undefined;

  if (count > VERCEL_SANDBOX_TAG_LIMIT) {
    throw new Error(
      `Vercel Sandbox supports at most ${VERCEL_SANDBOX_TAG_LIMIT} tags. ` +
        'eve reserves "agent", "channel", and "sessionId"; remove or consolidate custom tags passed to vercel().',
    );
  }

  return tags;
}

export async function ensureVercelSandboxTags(
  sandbox: {
    readonly tags?: Record<string, string>;
    update(options: { tags: Record<string, string> }): Promise<unknown>;
  },
  tags: Record<string, string> | undefined,
): Promise<void> {
  if (tags === undefined || areVercelSandboxTagsEqual(sandbox.tags, tags)) return;
  await sandbox.update({ tags });
}

function areVercelSandboxTagsEqual(
  current: Record<string, string> | undefined,
  next: Record<string, string>,
): boolean {
  const currentTags = current ?? {};
  const currentEntries = Object.entries(currentTags);
  const nextEntries = Object.entries(next);
  if (currentEntries.length !== nextEntries.length) return false;
  return nextEntries.every(([key, value]) => currentTags[key] === value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseJson = (error as { readonly json?: unknown }).json;
    const responseText = (error as { readonly text?: unknown }).text;
    const responseBody =
      typeof responseText === "string" && responseText.length > 0
        ? responseText
        : responseJson !== undefined
          ? JSON.stringify(responseJson)
          : undefined;
    if (responseBody !== undefined) return `${error.message}: ${responseBody}`;
    return error.message;
  }
  return String(error);
}
