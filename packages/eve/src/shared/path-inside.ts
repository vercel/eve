import { isAbsolute, relative, resolve, sep } from "node:path";

/** Reports whether `path` is `directory` itself or lies anywhere beneath it. */
export function isPathInsideOrEqual(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
