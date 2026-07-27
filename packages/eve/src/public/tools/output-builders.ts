import type { ToolModelOutput, ToolModelOutputPart } from "#shared/tool-definition.js";

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
