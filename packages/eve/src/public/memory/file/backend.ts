/** One versioned text document loaded from a memory backend. */
export interface MemoryDocument {
  /** Complete UTF-8 document contents. */
  readonly content: string;
  /** Opaque backend version used for optimistic writes. */
  readonly version: string;
}

/** Input shared by document reads. */
export interface MemoryDocumentReadInput {
  /** Stable eve scope key for the authored memory slot. */
  readonly key: string;
  readonly signal: AbortSignal;
}

/** Input for a conditional document replacement. */
export interface MemoryDocumentWriteInput extends MemoryDocumentReadInput {
  readonly content: string;
  /** Version returned by {@link MemoryDocumentBackend.read}, or `null` for create-only. */
  readonly expectedVersion: string | null;
}

/**
 * Storage seam for one bounded memory file per eve scope key.
 *
 * Implementations may map the key to a KV entry, blob object, database row,
 * or another durable store. Writes must reject stale `expectedVersion` values
 * with {@link MemoryDocumentConflictError}.
 */
export interface MemoryDocumentBackend {
  readonly read: (input: MemoryDocumentReadInput) => Promise<MemoryDocument | null>;
  readonly write: (input: MemoryDocumentWriteInput) => Promise<MemoryDocument>;
}

/** Raised when a document changed between read and conditional write. */
export class MemoryDocumentConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Memory document "${key}" changed before it could be updated.`);
    this.name = "MemoryDocumentConflictError";
    this.key = key;
  }

  /** Narrows conflicts across bundle and workflow boundaries. */
  static is(error: unknown): error is MemoryDocumentConflictError {
    return (
      error instanceof MemoryDocumentConflictError ||
      (typeof error === "object" &&
        error !== null &&
        (error as { readonly name?: unknown }).name === "MemoryDocumentConflictError" &&
        typeof (error as { readonly key?: unknown }).key === "string")
    );
  }
}
