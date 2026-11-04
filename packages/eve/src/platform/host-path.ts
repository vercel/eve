// The host process's working directory, for code that also runs in a browser. `host-path.web.ts`
// is the browser's twin; the package's `#platform/*` imports pick one by the `node` condition.

/** Where paths a host reads relative to itself resolve from. */
export function hostWorkingDirectory(): string {
  return process.cwd();
}

// The host platform's own path rules (win32 on Windows), for names and paths that came from it.
export { basename, dirname, extname, join, resolve } from "node:path";
