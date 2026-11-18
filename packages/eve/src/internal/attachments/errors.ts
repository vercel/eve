type EveAttachmentErrorKind = "resolver-threw";

interface EveAttachmentErrorInput {
  readonly kind: EveAttachmentErrorKind;
  readonly message: string;
  readonly adapterKind?: string;
  readonly cause?: unknown;
}

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
