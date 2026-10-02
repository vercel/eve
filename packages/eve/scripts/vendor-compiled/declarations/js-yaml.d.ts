// Hand-authored declaration for the vendored slice of `js-yaml` v4, which
// ships no types. Only `load` is vendored.

export interface LoadOptions {
  /** File name used in error messages. */
  filename?: string;
  /** Allows duplicate mapping keys, keeping the last value. Defaults to `false`. */
  json?: boolean;
}

/** Parses one YAML document with the default (data-only) schema. */
export function load(source: string, options?: LoadOptions): unknown;
