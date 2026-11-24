import { joinPosix } from "./posix-path.web.js";
import type {
  loadSandboxPreparedArtifact as NodeLoad,
  resolveSandboxCacheDirectory as NodeResolve,
} from "./sandbox-cache.js";

export const resolveSandboxCacheDirectory: typeof NodeResolve = (appRoot) =>
  joinPosix(appRoot, ".eve", "sandbox-cache");

export const loadSandboxPreparedArtifact: typeof NodeLoad = async () => {
  throw new Error(
    "A prepared sandbox template belongs to an agent compiled from files, which runs only on a Node host.",
  );
};
