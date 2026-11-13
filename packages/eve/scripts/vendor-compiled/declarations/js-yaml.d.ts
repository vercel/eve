// Hand-authored declaration for the vendored slice of `js-yaml` v5: the
// loader, the YAML 1.2 core schema, and the `<<` merge tag.

declare const tagDefinition: unique symbol;

/** A YAML tag definition, opaque to eve. */
export interface TagDefinition {
  readonly [tagDefinition]: true;
}

/** The set of tags the loader resolves. */
export interface Schema {
  /** Returns a copy of this schema with the given tags added. */
  withTags(...tags: TagDefinition[]): Schema;
}

export interface LoadOptions {
  /** File name used in error messages. */
  filename?: string;
  /** Tags to resolve. Defaults to `CORE_SCHEMA`. */
  schema?: Schema;
}

/** YAML 1.2 core schema: strings, numbers, booleans, null, sequences, and mappings. */
export const CORE_SCHEMA: Schema;

/** Resolves `<<` merge keys, bounded by the loader's merge limits. */
export const mergeTag: TagDefinition;

/** Parses every document in a YAML stream. An empty stream has no documents. */
export function loadAll(source: string, options?: LoadOptions): unknown[];
