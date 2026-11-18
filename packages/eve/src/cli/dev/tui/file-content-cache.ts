const MAX_CACHED_CONTENT_CHARS = 200_000;

interface FileSnapshot {
  content?: string;
  previous?: string;
  writerCallId?: string;
}

export class FileContentCache {
  readonly #byPath = new Map<string, FileSnapshot>();

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

  forget(path: string): void {
    const entry = this.#byPath.get(path);
    if (entry?.writerCallId === undefined) {
      this.#byPath.delete(path);
      return;
    }
    const snapshot: FileSnapshot = { writerCallId: entry.writerCallId };
    if (entry.previous !== undefined) snapshot.previous = entry.previous;
    this.#byPath.set(path, snapshot);
  }

  clear(): void {
    this.#byPath.clear();
  }

  observeRead(output: unknown): void {
    const result = readFileResultShape(output);
    if (result === undefined || result.truncated) return;
    if (result.content.length > MAX_CACHED_CONTENT_CHARS) return;

    const lines = reconstructNumberedLines(result.content);
    if (lines === undefined || lines.length !== result.totalLines) return;

    this.#byPath.set(result.path, { content: lines.join("\n") });
  }
}

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
