import { isObject } from "#shared/guards.js";
import type { ToolModelOutput, ToolModelOutputContext } from "#tools/model-output.js";

const RESULTS_DIRECTORY = "/tmp/.eve/tool-results";
const BYTES_PER_TOKEN = 4;
const SHAPE_LIMIT = 400;
const TEXT_PREVIEW_LINES = 20;
const TEXT_PREVIEW_LINE_LIMIT = 200;

/** Options for {@link offloadSandbox}. */
export interface OffloadSandboxOptions<TOutput> {
  /**
   * Largest result, in estimated tokens (UTF-8 bytes divided by 4), that
   * goes to the model as it is. A larger result is written to a sandbox file
   * and the model gets a short note with the file's path.
   */
  readonly maxOutputTokens: number;
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
 * context. A result over `maxOutputTokens` is written to a file under
 * `/tmp/.eve/tool-results/` in the session's sandbox, and the model gets the
 * file's path and a one-line description of its shape, so it can read parts
 * of it with `jq`, `head` or `read_file`.
 *
 * The file holds the tool's raw output. Without a sandbox the result goes to
 * the model unchanged, and eve logs one warning per session. Error results
 * and results with file parts are never written.
 *
 * ```ts
 * defineMcpClientConnection({
 *   url,
 *   toolCall: { toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 }) },
 * });
 * ```
 */
export function offloadSandbox<TOutput = unknown>(
  options: OffloadSandboxOptions<TOutput>,
): (output: TOutput, ctx: ToolModelOutputContext) => Promise<ToolModelOutput> {
  const { maxOutputTokens } = options;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new TypeError("offloadSandbox: maxOutputTokens must be a positive integer.");
  }
  return async (output, ctx) => {
    const projected =
      options.toModelOutput === undefined
        ? ctx.defaultModelOutput(output)
        : await options.toModelOutput(output, ctx);
    const size = projectedBytes(projected);
    if (size === undefined || Math.ceil(size / BYTES_PER_TOKEN) <= maxOutputTokens) {
      return projected;
    }
    const sandbox = await ctx.getSandbox();
    if (sandbox === undefined) {
      ctx.warnOnce(
        "offloadSandbox.no-sandbox",
        `offloadSandbox could not save the result of ${ctx.toolName}: the agent has no sandbox, so the model gets the whole result.`,
      );
      return projected;
    }
    const file = serialize(output);
    const path = `${RESULTS_DIRECTORY}/${fileStem(ctx)}.${file.extension}`;
    await sandbox.writeTextFile({ content: file.text, path });
    return {
      type: "text",
      value: offloadNote({ file, output, path, toolName: ctx.toolName }),
    };
  };
}

function projectedBytes(output: ToolModelOutput): number | undefined {
  switch (output.type) {
    case "error-text":
      return undefined;
    case "text":
      return Buffer.byteLength(output.value);
    case "json":
      return Buffer.byteLength(JSON.stringify(output.value) ?? "null");
    case "content": {
      if (output.value.some((part) => part.type === "file")) return undefined;
      return output.value.reduce(
        (total, part) => total + (part.type === "text" ? Buffer.byteLength(part.text) : 0),
        0,
      );
    }
  }
}

interface SerializedResult {
  readonly bytes: number;
  readonly extension: "json" | "txt";
  readonly text: string;
}

function serialize(output: unknown): SerializedResult {
  const isText = typeof output === "string";
  const text = isText ? output : (JSON.stringify(output) ?? "null");
  return { bytes: Buffer.byteLength(text), extension: isText ? "txt" : "json", text };
}

function fileStem(ctx: ToolModelOutputContext): string {
  return `${ctx.toolName}-${ctx.callId}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function offloadNote(input: {
  readonly file: SerializedResult;
  readonly output: unknown;
  readonly path: string;
  readonly toolName: string;
}): string {
  const { file, path, toolName } = input;
  const tokens = Math.ceil(file.bytes / BYTES_PER_TOKEN);
  const shape = file.extension === "txt" ? textPreview(file.text) : jsonShape(input.output);
  return [
    `The result of ${toolName} was saved to`,
    path,
    `(${file.bytes.toLocaleString("en-US")} bytes, about ${tokens.toLocaleString("en-US")} tokens).`,
    shape,
    "Read parts of it with jq, head or read_file.",
  ].join("\n");
}

function textPreview(text: string): string {
  const lines = text
    .split("\n")
    .slice(0, TEXT_PREVIEW_LINES)
    .map((line) =>
      line.length > TEXT_PREVIEW_LINE_LIMIT ? `${line.slice(0, TEXT_PREVIEW_LINE_LIMIT)}...` : line,
    );
  return `It is text. Its first ${lines.length} lines are:\n${lines.join("\n")}`;
}

function jsonShape(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0];
    const noun = value.length === 1 ? "item" : "items";
    const head = `It is a JSON array of ${value.length.toLocaleString("en-US")} ${noun}`;
    if (isObject(first)) {
      return `${head}. The first item is an object with the keys: ${keyList(Object.keys(first))}.`;
    }
    return first === undefined
      ? `${head}.`
      : `${head}. The first item is ${describeScalar(first)}.`;
  }
  if (isObject(value)) {
    return `It is a JSON object with the keys: ${keyList(Object.keys(value))}.`;
  }
  return `It is ${describeScalar(value)}.`;
}

function describeScalar(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function keyList(keys: readonly string[]): string {
  const total = keys.length;
  if (total === 0) return "none";
  const listed: string[] = [];
  let length = 0;
  for (const key of keys) {
    length += key.length + 2;
    if (length > SHAPE_LIMIT && listed.length > 0) break;
    listed.push(key);
  }
  return listed.length === total ? listed.join(", ") : `${listed.join(", ")}, ... (${total} keys)`;
}
