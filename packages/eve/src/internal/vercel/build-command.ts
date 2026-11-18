import { relative } from "node:path";

import { shellQuote } from "#shared/shell-quote.js";

export const quoteVercelShellArgument = shellQuote;

export function toVercelRelativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/") || ".";
}
