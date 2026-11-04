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
 * file data is the SDK's tagged `FileData` union restricted to a base64
 * `{ type: "data" }` payload or an `https:` `{ type: "url" }` string, so
 * persisted tool results survive the durable JSON boundary. Use the
 * `toolOutputPart` builders from `eve/tools` to construct parts without
 * hand-writing the nesting.
 */
export type ToolModelOutputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      /**
       * Tagged file data: a base64 payload, or an `https:` URL the
       * provider fetches itself. A URL must stay readable for the whole
       * session because every later model call sends it again.
       */
      readonly data:
        | { readonly type: "data"; readonly data: string }
        | { readonly type: "url"; readonly url: string };
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
    return filePart({ type: "data", data: base64 }, options);
  },
  /**
   * Builds a file part from an `https:` URL, e.g. a presigned object
   * storage link. The provider fetches the file, so eve neither downloads
   * it nor stores its bytes in session history. Every later model call
   * sends the URL again, so it must not expire before the session ends.
   */
  fileUrl(
    url: string,
    options: { readonly mediaType: string; readonly filename?: string },
  ): ToolModelOutputPart {
    return filePart({ type: "url", url }, options);
  },
};

function filePart(
  data: Extract<ToolModelOutputPart, { readonly type: "file" }>["data"],
  options: { readonly mediaType: string; readonly filename?: string },
): ToolModelOutputPart {
  return options.filename === undefined
    ? { type: "file", data, mediaType: options.mediaType }
    : { type: "file", data, mediaType: options.mediaType, filename: options.filename };
}
