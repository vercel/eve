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
