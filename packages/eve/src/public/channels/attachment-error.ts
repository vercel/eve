import { EveAttachmentError } from "#internal/attachments/errors.js";

/**
 * Builds the error a channel's `fetchFile` throws to tell the model why one
 * attachment didn't arrive. eve replaces the attachment with
 * `Attachment <name> could not be retrieved: <message>`, continues the turn,
 * and keeps `cause` in operator logs.
 *
 * The model reads `message` as written. Name what the person can act on, such
 * as a size limit or a missing permission, and never include URLs, tokens, or
 * upstream response text. Any other error from `fetchFile` reaches the model as
 * a generic note.
 */
export function attachmentError(message: string, options?: { readonly cause?: unknown }): Error {
  return new EveAttachmentError({ cause: options?.cause, kind: "resolver-threw", message });
}
