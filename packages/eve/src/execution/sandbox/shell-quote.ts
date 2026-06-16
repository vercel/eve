/**
 * Wraps a value in POSIX single-quotes, escaping any embedded single-quotes.
 *
 * Used by the `glob` and `grep` execution cores to safely embed model-supplied
 * patterns, paths, and globs into shell commands run via `sandbox.run`.
 *
 * The quoting strategy is the standard POSIX approach: wrap the value in
 * single-quotes and replace each embedded `'` with `'\''` (end the
 * single-quoted string, insert an escaped single-quote, re-open
 * single-quoting).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
