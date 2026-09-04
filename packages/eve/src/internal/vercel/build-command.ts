import { relative } from "node:path";

import { shellQuote } from "#shared/shell-quote.js";

/** Quote one argument for Vercel's POSIX build-command shell. */
export const quoteVercelShellArgument = shellQuote;

/** Return a portable relative path for a generated Vercel configuration. */
export function toVercelRelativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/") || ".";
}
