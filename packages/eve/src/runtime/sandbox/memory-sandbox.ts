import { createIndexedDbSandboxFileStore } from "#browser/sandbox-files.js";
import { hasIndexedDb } from "#browser/indexed-db.js";
import { hostWorkingDirectory } from "#platform/host-path.js";
import { codeSandboxWith, type CodeSandbox } from "#runtime/sandbox/code-sandbox-registry.js";
import { MemorySandbox } from "#sandbox/providers/memory.js";
import {
  createMemorySandboxFileStore,
  type SandboxFileStore,
} from "#execution/sandbox/memory-files.js";

/** Where `memorySandbox()` keeps its sessions' files. */
export interface MemorySandboxOptions {
  /**
   * Where a session's workspace outlives its interpreter. Defaults to the realm's IndexedDB
   * (`createIndexedDbSandboxFileStore()`), so a page's files survive a reload; a realm without
   * one (Node) keeps them in memory, for as long as the process.
   */
  readonly files?: SandboxFileStore;
}

/**
 * A shell and files in memory for a code agent (`MemorySandbox`): pass it as
 * `eve.defaults({ sandbox })`. Nothing reaches the host.
 */
export function memorySandbox(options: MemorySandboxOptions = {}): CodeSandbox {
  const files =
    options.files ??
    (hasIndexedDb() ? createIndexedDbSandboxFileStore() : createMemorySandboxFileStore());
  return codeSandboxWith(MemorySandbox.environment({ files }), {
    appRoot: hostWorkingDirectory(),
    // Nothing to build: a new session starts from an empty workspace.
    preparedArtifact: async () => null,
    revision: "code:memory",
  });
}
