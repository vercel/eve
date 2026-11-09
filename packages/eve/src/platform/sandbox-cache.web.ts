import { joinPosix } from "./posix-path.web.js";
import type {
  loadSandboxPreparedArtifact as NodeLoad,
  resolveSandboxCacheDirectory as NodeResolve,
} from "./sandbox-cache.js";

// A browser's sandboxes live in memory (or IndexedDB), under the same path a Node host's cache
// uses, and only an agent compiled from files has prepared templates, which a browser can't run.
// `sandbox-cache.ts` is the Node twin.

export const resolveSandboxCacheDirectory: typeof NodeResolve = (appRoot) =>
  joinPosix(appRoot, ".eve", "sandbox-cache");

export const loadSandboxPreparedArtifact: typeof NodeLoad = async () => {
  throw new Error(
    "A prepared sandbox template belongs to an agent compiled from files, which runs only on a Node host.",
  );
};
