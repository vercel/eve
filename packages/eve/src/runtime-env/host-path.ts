export function hostWorkingDirectory(): string {
  return process.cwd();
}

export { basename, dirname, extname, join, resolve } from "node:path";
