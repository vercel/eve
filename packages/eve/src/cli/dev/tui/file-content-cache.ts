/**
 * Session-local knowledge of file contents, so the write block can show a
 * real diff without any protocol addition. Two feeds keep it current: every
 * `write_file` input is a full replacement (exact), and every full-file
 * `read_file` result reconstructs to the file's exact lines. Files touched
 * outside these two paths (e.g. by `bash`) are invisible here — a write over
 * unknown prior content renders plain rather than pretending to be a diff.
 */

/** Contents past this size are not cached or diffed. */
const MAX_CACHED_CONTENT_CHARS = 200_000;

interface FileSnapshot {
  content: string;
  /** What `content` replaced, kept while `writerCallId`'s call re-renders. */
  previous?: string;
  writerCallId?: string;
}

export class FileContentCache {
  readonly #byPath = new Map<string, FileSnapshot>();

  /**
   * Records one write and returns the content it replaced. Tool blocks
   * re-render on every lifecycle event of the same call, so a repeated
   * observation of `callId` keeps returning the original previous content
   * instead of diffing the write against itself.
   */
  observeWrite(input: { path: string; content: string; callId: string }): string | undefined {
    const entry = this.#byPath.get(input.path);
    if (entry?.writerCallId === input.callId) return entry.previous;

    if (input.content.length > MAX_CACHED_CONTENT_CHARS) {
      this.#byPath.delete(input.path);
      return undefined;
    }

    const previous = entry?.content;
    const snapshot: FileSnapshot = { content: input.content, writerCallId: input.callId };
    if (previous !== undefined) snapshot.previous = previous;
    this.#byPath.set(input.path, snapshot);
    return previous;
  }

  /**
   * Forgets everything. A new conversation runs against a fresh session —
   * possibly a fresh sandbox — so stale bases would produce confidently
   * wrong diffs.
   */
  clear(): void {
    this.#byPath.clear();
  }

  /**
   * Records a read result when it provably covers the whole file: not
   * truncated, starting at line 1, with exactly `totalLines` numbered lines.
   * Partial or truncated reads are ignored — caching them would produce
   * confidently wrong diffs later.
   */
  observeRead(output: unknown): void {
    const result = readFileResultShape(output);
    if (result === undefined || result.truncated) return;
    if (result.content.length > MAX_CACHED_CONTENT_CHARS) return;

    const lines = reconstructNumberedLines(result.content);
    if (lines === undefined || lines.length !== result.totalLines) return;

    this.#byPath.set(result.path, { content: lines.join("\n") });
  }
}

/** Duck-types the shared read-file result, whatever the tool was named. */
function readFileResultShape(
  output: unknown,
): { content: string; path: string; totalLines: number; truncated: boolean } | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  const { content, path, totalLines, truncated } = record;
  if (typeof content !== "string" || typeof path !== "string") return undefined;
  if (typeof totalLines !== "number" || typeof truncated !== "boolean") return undefined;
  return { content, path, totalLines, truncated };
}

/**
 * Strips the `N: ` prefixes of a read result. Returns `undefined` unless the
 * numbering is contiguous from 1 — anything else means a windowed read.
 */
function reconstructNumberedLines(content: string): string[] | undefined {
  if (content === "") return [];
  const lines: string[] = [];
  for (const [index, raw] of content.split("\n").entries()) {
    const match = /^(\d+): (.*)$/su.exec(raw);
    if (match === null || Number(match[1]) !== index + 1) return undefined;
    lines.push(match[2]!);
  }
  return lines;
}
