import { isObject } from "#shared/guards.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  defaultToolModelOutput,
  WARN_ONCE,
  type ToolModelOutput,
  type ToolModelOutputContext,
  type WarnOnceContext,
} from "#tools/model-output.js";

const RESULTS_DIRECTORY = "/tmp/.eve/tool-results";
const SHAPE_LIMIT = 400;
const TEXT_PREVIEW_LINES = 20;
const TEXT_PREVIEW_LINE_LIMIT = 200;
const NESTED_KEYS_LIMIT = 120;
const FILE_STEM_PART_LIMIT = 64;

const DEFAULT_MAX_BYTES = 20_000;
const MAX_SAVED_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 100 * 1024 * 1024;
const MAX_DIRECTORY_FILES = 100;
const MAX_LISTING_BYTES = 64 * 1024;

/** Options for {@link offloadContent}. */
export interface OffloadContentOptions<TOutput> {
  /**
   * Largest result, in UTF-8 bytes, that goes to the model as it is. A larger
   * result is written to a sandbox file and the model gets a short note with
   * the file's path. Defaults to 20,000 bytes, about 5,000 tokens.
   */
  readonly maxBytes?: number;
  /**
   * What the model gets when a result is over `maxBytes` and cannot be saved,
   * because it is over 10 MB, there is no sandbox that keeps files after the
   * call, or opening the sandbox, writing the file or measuring the saved
   * results fails. eve logs one warning per session either way.
   *
   * - `"inline"` sends the projected result, so nothing is lost and the context may
   *   grow. This is the default.
   * - `"summary"` sends only its size, shape and first lines, so the context
   *   stays small and the rest of the result is gone.
   */
  readonly fallback?: "inline" | "summary";
  /**
   * Projects the output before its size is checked. Defaults to
   * `ctx.defaultModelOutput`, which is what the model sees without a
   * `toModelOutput`.
   */
  readonly toModelOutput?: (
    output: TOutput,
    ctx: ToolModelOutputContext,
  ) => ToolModelOutput | Promise<ToolModelOutput>;
}

/**
 * Builds a `toModelOutput` that keeps a large tool result out of the model's
 * context. A result over `maxBytes` is written to a file under
 * `/tmp/.eve/tool-results/` in the session's sandbox, and the model gets the
 * file's path and a one-line description of its shape, so it can read parts
 * of it with `jq`, `head` or `read_file`.
 *
 * The file holds the projected output, the same text or JSON the model would
 * have seen, so a `toModelOutput` that redacts a field also keeps it out of
 * the file. A result over 10 MB is never saved. The sandbox keeps at most
 * 100 saved results and 100 MB of them: when a new result takes it over, the
 * oldest saved results are removed, so the model runs that tool again to get
 * one back. When a result cannot be saved, `fallback` decides what the model
 * gets. Error results and results with
 * file parts are never written.
 *
 * ```ts
 * defineMcpClientConnection({
 *   url,
 *   toolCall: { toModelOutput: offloadContent() },
 * });
 * ```
 */
export function offloadContent<TOutput = unknown>(
  options: OffloadContentOptions<TOutput> = {},
): (output: TOutput, ctx?: ToolModelOutputContext) => Promise<ToolModelOutput> {
  const { maxBytes = DEFAULT_MAX_BYTES, fallback = "inline" } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("offloadContent: maxBytes must be a positive integer.");
  }
  return async (output, ctx = DIRECT_CALL_CONTEXT) => {
    const projected =
      options.toModelOutput === undefined
        ? ctx.defaultModelOutput(output)
        : await options.toModelOutput(output, ctx);
    const file = serialize(projected);
    if (file === undefined || file.bytes <= maxBytes) {
      return projected;
    }
    const path = `${RESULTS_DIRECTORY}/${fileStem(ctx)}.${file.extension}`;
    const note = (saved: boolean): string =>
      offloadNote({
        budget: Math.floor(maxBytes / 4),
        file,
        path: saved ? path : undefined,
        toolName: ctx.toolName,
      });
    const notSaved = (): ToolModelOutput =>
      fallback === "inline" ? projected : { type: "text", value: note(false) };
    const warn = (ctx as Partial<WarnOnceContext>)[WARN_ONCE];
    const given = fallback === "inline" ? "the whole result" : "only a description of it";
    if (file.bytes > MAX_SAVED_BYTES) {
      warn?.(
        "offloadContent.too-large",
        `offloadContent did not save a tool result because it is over ${MAX_SAVED_BYTES.toLocaleString("en-US")} bytes, so the model gets ${given}.`,
        { bytes: file.bytes, toolName: ctx.toolName },
      );
      return notSaved();
    }
    try {
      const sandbox = await ctx.getSandbox();
      if (sandbox === undefined) {
        warn?.(
          "offloadContent.no-sandbox",
          `offloadContent did not save a tool result because there is no sandbox that keeps files after the call (the agent has none, or the tool was invoked without a tool-session key), so the model gets ${given}.`,
          { toolName: ctx.toolName },
        );
        return notSaved();
      }
      await sandbox.writeTextFile({ content: file.text, path });
      await evictOldest(sandbox, path).catch(async (error: unknown) => {
        await sandbox.removePath({ force: true, path });
        throw error;
      });
    } catch (error) {
      warn?.(
        "offloadContent.save-failed",
        `offloadContent could not save a tool result, so the model gets ${given}.`,
        { error: error instanceof Error ? error.message : String(error), toolName: ctx.toolName },
      );
      return notSaved();
    }
    return { type: "text", value: note(true) };
  };
}

async function evictOldest(sandbox: SandboxSession, keep: string): Promise<void> {
  const { stdout } = await sandbox.run({
    command: `find ${RESULTS_DIRECTORY} -maxdepth 1 -type f -exec sh -c 'stat -c "%Y %s %n" "$@" 2>/dev/null || stat -f "%m %z %N" "$@" 2>/dev/null' _ {} + | head -c ${MAX_LISTING_BYTES}`,
  });
  if (Buffer.byteLength(stdout) >= MAX_LISTING_BYTES) {
    throw new Error("too many saved tool results to measure");
  }
  const saved: { readonly bytes: number; readonly modified: number; readonly path: string }[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\d+) (\d+) (.+)$/.exec(line);
    if (match === null || !match[3]!.startsWith(`${RESULTS_DIRECTORY}/`)) continue;
    saved.push({ bytes: Number(match[2]), modified: Number(match[1]), path: match[3]! });
  }
  if (!saved.some((entry) => entry.path === keep)) {
    throw new Error("could not measure the saved tool results");
  }
  let bytes = saved.reduce((total, entry) => total + entry.bytes, 0);
  let files = saved.length;
  const oldestFirst = saved
    .filter((entry) => entry.path !== keep)
    .sort((a, b) => a.modified - b.modified || (a.path < b.path ? -1 : 1));
  for (const entry of oldestFirst) {
    if (bytes <= MAX_DIRECTORY_BYTES && files <= MAX_DIRECTORY_FILES) return;
    await sandbox.removePath({ force: true, path: entry.path });
    bytes -= entry.bytes;
    files -= 1;
  }
}

const DIRECT_CALL_CONTEXT: ToolModelOutputContext = {
  callId: "direct",
  defaultModelOutput: defaultToolModelOutput,
  getSandbox: async () => undefined,
  toolName: "tool",
};

const encoder = new TextEncoder();

interface SerializedResult {
  readonly bytes: number;
  readonly extension: "json" | "txt";
  readonly shape: (budget: number) => string;
  readonly text: string;
}

function serialize(projected: ToolModelOutput): SerializedResult | undefined {
  switch (projected.type) {
    case "error-text":
      return undefined;
    case "text":
      return textResult(projected.value);
    case "json": {
      const text = JSON.stringify(projected.value) ?? "null";
      return {
        bytes: encoder.encode(text).byteLength,
        extension: "json",
        shape: (budget) => jsonShape(projected.value, budget),
        text,
      };
    }
    case "content": {
      if (projected.value.some((part) => part.type === "file")) return undefined;
      return textResult(
        projected.value.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
      );
    }
  }
}

function textResult(text: string): SerializedResult {
  return {
    bytes: encoder.encode(text).byteLength,
    extension: "txt",
    shape: (budget) => textPreview(text, budget),
    text,
  };
}

function fileStem(ctx: ToolModelOutputContext): string {
  return `${boundedName(ctx.toolName)}-${boundedName(ctx.callId)}`;
}

function boundedName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length <= FILE_STEM_PART_LIMIT) return safe;
  return `${safe.slice(0, FILE_STEM_PART_LIMIT - 9)}-${hash(value)}`;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function offloadNote(input: {
  readonly budget: number;
  readonly file: SerializedResult;
  readonly path: string | undefined;
  readonly toolName: string;
}): string {
  const { file, path, toolName } = input;
  const size = `${file.bytes.toLocaleString("en-US")} bytes`;
  const shape = file.shape(input.budget);
  if (path === undefined) {
    return [
      `Output of ${toolName} (${size}) exceeded the inline limit and could not be saved to the sandbox. Only a summary is shown below.`,
      shape,
    ].join("\n");
  }
  const tools =
    file.extension === "json"
      ? "bash (for example jq) or read_file"
      : "read_file or bash (for example head, sed, or grep)";
  return [
    `Output of ${toolName} (${size}) was saved to ${path}.`,
    shape,
    `Inspect it with ${tools} instead of loading the entire file.`,
  ].join("\n");
}

function textPreview(text: string, budget: number): string {
  const shown: string[] = [];
  let used = 0;
  let total = 0;
  let capped = false;
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline === -1 && start === text.length && start > 0) break;
    total += 1;
    const end = newline === -1 ? text.length : newline;
    if (!capped && shown.length < TEXT_PREVIEW_LINES) {
      const room = Math.max(budget - used, 0);
      if (room === 0 && shown.length > 0) {
        capped = true;
      } else {
        const lineEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const length = lineEnd - start;
        const limit = Math.min(TEXT_PREVIEW_LINE_LIMIT, room);
        shown.push(
          length > limit ? `${text.slice(start, start + limit)}...` : text.slice(start, lineEnd),
        );
        used += Math.min(length, limit) + 1;
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  const count = `${total.toLocaleString("en-US")} ${total === 1 ? "line" : "lines"}`;
  const lead =
    shown.length === total
      ? "Preview:"
      : `First ${shown.length} ${shown.length === 1 ? "line" : "lines"}:`;
  return `Text (${count}). ${lead}\n${shown.join("\n")}`;
}

function jsonShape(value: unknown, budget: number): string {
  if (Array.isArray(value)) return `JSON ${arrayShape(value, budget)}.`;
  if (isObject(value)) {
    const keys = Object.keys(value);
    const describe = (index: number): string => {
      const key = keys[index] as string;
      const entry = value[key];
      return Array.isArray(entry) ? `${key} (${arrayShape(entry, budget)})` : key;
    };
    return `JSON object with keys: ${entryList(keys.length, describe, Math.min(SHAPE_LIMIT, budget))}.`;
  }
  return `JSON ${describeScalar(value)}.`;
}

function arrayShape(items: readonly unknown[], budget: number): string {
  const count = items.length.toLocaleString("en-US");
  const first = items[0];
  if (isObject(first)) {
    const keys = Object.keys(first);
    return `array of ${count} ${items.length === 1 ? "object" : "objects"} with keys: ${entryList(keys.length, (index) => keys[index] as string, Math.min(NESTED_KEYS_LIMIT, budget))}`;
  }
  const noun = items.length === 1 ? "item" : "items";
  return first === undefined
    ? `array of ${count} ${noun}`
    : `array of ${count} ${noun}, the first is ${describeScalar(first)}`;
}

function describeScalar(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function entryList(total: number, entryAt: (index: number) => string, limit: number): string {
  if (total === 0) return "none";
  const listed: string[] = [];
  let length = 0;
  for (let index = 0; index < total; index += 1) {
    const entry = entryAt(index);
    const room = limit - length;
    if (listed.length === 0) {
      listed.push(entry.length > room ? `${entry.slice(0, Math.max(room, 0))}...` : entry);
      length += Math.min(entry.length, room) + 2;
      continue;
    }
    if (entry.length + 2 > room) break;
    listed.push(entry);
    length += entry.length + 2;
  }
  return listed.length === total ? listed.join(", ") : `${listed.join(", ")}, ... (${total} total)`;
}
