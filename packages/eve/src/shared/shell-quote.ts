/** Wraps a value in POSIX single quotes, escaping embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
