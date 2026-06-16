/**
 * Discriminator for {@link EveAttachmentError}.
 *
 * Today the only literal ever produced in the codebase is
 * `"resolver-threw"`. The union remains a discriminated type so future
 * producers can broaden it intentionally rather than as an accident of
 * a string parameter that drifted.
 */
type EveAttachmentErrorKind = "resolver-threw";

/**
 * Input shape for {@link EveAttachmentError}. Separated from the class
 * constructor so callers can build the options object inline and TS
 * can check the `kind` / `message` pair without a positional
 * constructor signature.
 */
interface EveAttachmentErrorInput {
  readonly kind: EveAttachmentErrorKind;
  readonly message: string;
  readonly adapterKind?: string;
  readonly cause?: unknown;
}

/**
 * Error surfaced when an attachment resolver fails to produce bytes for
 * an {@link AttachmentRef}.
 *
 * Channels can inspect the `.kind` discriminator to decide whether to
 * drop the attachment and continue the turn (the default posture for
 * every kind today) or fail the whole delivery (future strict mode).
 * The original failure, when there is one, is preserved on `.cause` so
 * observability can surface the upstream error without losing context.
 */
export class EveAttachmentError extends Error {
  readonly kind: EveAttachmentErrorKind;
  readonly adapterKind?: string;
  override readonly cause?: unknown;

  constructor(input: EveAttachmentErrorInput) {
    super(input.message);
    this.name = "EveAttachmentError";
    this.kind = input.kind;
    if (input.adapterKind !== undefined) {
      this.adapterKind = input.adapterKind;
    }
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}
