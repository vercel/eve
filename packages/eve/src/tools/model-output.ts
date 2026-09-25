/**
 * eve-owned shape for the model-facing tool result produced by
 * `toModelOutput`. Structurally compatible with the AI SDK's
 * `ToolResultOutput` so the harness can forward it without conversion.
 *
 * The `content` variant carries an ordered list of
 * {@link ToolModelOutputPart} entries, letting a tool hand the model
 * text alongside inline files (e.g. a screenshot as vision input).
 */
export type ToolModelOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "content"; readonly value: readonly ToolModelOutputPart[] };

/**
 * One part of a `content` {@link ToolModelOutput}. Mirrors the AI SDK's
 * `ToolResultOutput` content parts narrowed to the JSON-safe subset:
 * file data is the SDK's tagged `FileData` union restricted to
 * `{ type: "data" }` with a base64 string, so persisted tool results
 * survive the durable JSON boundary. Use the `toolOutputPart` builders
 * from `eve/tools` to construct parts without hand-writing the nesting.
 */
export type ToolModelOutputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      /** Tagged file data; only JSON-safe base64 payloads are accepted. */
      readonly data: { readonly type: "data"; readonly data: string };
      /** IANA media type, e.g. `image/png`. */
      readonly mediaType: string;
      readonly filename?: string;
    };

/**
 * Builders for the model-facing {@link ToolModelOutput} returned by
 * `toModelOutput`. Pure sugar over the union — each returns the
 * corresponding literal, and hand-written literals remain valid.
 *
 * ```ts
 * toModelOutput(output) {
 *   return toolOutput.content([
 *     toolOutputPart.text(`Screenshot of ${output.path}:`),
 *     toolOutputPart.file(output.screenshotBase64, { mediaType: "image/png" }),
 *   ]);
 * }
 * ```
 */
export const toolOutput = {
  /** Builds a text output: the model sees `value` as the tool result. */
  text(value: string): ToolModelOutput {
    return { type: "text", value };
  },
  /** Builds a JSON output; `value` must be JSON-serializable. */
  json(value: unknown): ToolModelOutput {
    return { type: "json", value };
  },
  /** Builds a content output from ordered {@link ToolModelOutputPart} entries. */
  content(value: readonly ToolModelOutputPart[]): ToolModelOutput {
    return { type: "content", value };
  },
};

/**
 * Builders for `content` {@link ToolModelOutput} parts. Pure sugar over
 * {@link ToolModelOutputPart} — each returns the corresponding part
 * literal, and hand-written literals remain valid.
 *
 * ```ts
 * toModelOutput(output) {
 *   return {
 *     type: "content",
 *     value: [
 *       toolOutputPart.text(`Screenshot of ${output.path}:`),
 *       toolOutputPart.file(output.screenshotBase64, { mediaType: "image/png" }),
 *     ],
 *   };
 * }
 * ```
 */
export const toolOutputPart = {
  /** Builds a text part. */
  text(text: string): ToolModelOutputPart {
    return { type: "text", text };
  },
  /**
   * Builds a file part from a base64 payload. Binary data must be
   * base64-encoded by the caller; raw bytes are rejected by the harness
   * because they do not survive the durable JSON boundary.
   */
  file(
    base64: string,
    options: { readonly mediaType: string; readonly filename?: string },
  ): ToolModelOutputPart {
    const part: {
      type: "file";
      data: { type: "data"; data: string };
      mediaType: string;
      filename?: string;
    } = {
      type: "file",
      data: { type: "data", data: base64 },
      mediaType: options.mediaType,
    };
    if (options.filename !== undefined) {
      part.filename = options.filename;
    }
    return part;
  },
};
