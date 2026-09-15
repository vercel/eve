import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_DIRECTORY = "index/v1";
const CONVERSATIONS_DIRECTORY = `${INDEX_DIRECTORY}/conversations`;
const INDEXED_MARKER = `${INDEX_DIRECTORY}/indexed`;

/** A path-safe, non-reversible key for one recorded conversation identifier. */
export function localTraceConversationIndexKey(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex");
}

/** Marker path relative to one trace directory. */
export function localTraceConversationMarker(conversationId: string): string {
  return `${CONVERSATIONS_DIRECTORY}/${localTraceConversationIndexKey(conversationId)}`;
}

/** Marker proving that a trace was written by an index-aware writer. */
export function localTraceIndexedMarker(): string {
  return INDEXED_MARKER;
}

/**
 * Records conversation membership without rewriting shared state. Empty marker
 * creation is idempotent, so overlapping dev workers cannot lose each other's
 * conversation entries.
 */
export async function indexLocalTraceConversation(input: {
  readonly conversationId: string;
  readonly traceDirectory: string;
}): Promise<void> {
  const conversationMarker = join(
    input.traceDirectory,
    localTraceConversationMarker(input.conversationId),
  );
  await mkdir(join(input.traceDirectory, CONVERSATIONS_DIRECTORY), { recursive: true });
  await createMarker(conversationMarker);
  await createMarker(join(input.traceDirectory, INDEXED_MARKER));
}

async function createMarker(path: string): Promise<void> {
  try {
    await writeFile(path, "", { flag: "wx" });
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
  }
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
