import type { ToolModelOutputPart } from "#shared/tool-definition.js";

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
