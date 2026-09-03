import { relative } from "node:path";

/** Quote one argument for Vercel's POSIX build-command shell. */
export function quoteVercelShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Return a portable relative path for a generated Vercel configuration. */
export function toVercelRelativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/") || ".";
}
