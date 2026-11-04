// A page has no working directory. Its sandboxes are in memory, with POSIX paths, so the root is
// where a host path resolves from, and a host path follows POSIX rules. `host-path.ts` is the
// Node twin.

/** Where paths a host reads relative to itself resolve from. */
export function hostWorkingDirectory(): string {
  return "/";
}

export {
  basenamePosix as basename,
  dirnamePosix as dirname,
  extnamePosix as extname,
  joinPosix as join,
  resolvePosix as resolve,
} from "./posix-path.web.js";
