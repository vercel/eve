// eve in a browser page or Web Worker, internally (`#browser/index.js`): any bundler builds it with
// no configuration. Nothing it reaches imports a Node built-in or names a Node global, and the
// reach guard (`scripts/browser-reach.mjs`) holds both at 0. `#platform/*` picks the browser's
// twins by the `node` condition.
export {
  defineConnection,
  defineContext,
  defineInstructions,
  defineSkill,
  type Dynamic,
} from "#embed/agent.js";
export {
  defineAgent,
  type AgentContentsDefinition,
  type AgentDefinition,
  type DefinedAgent,
} from "#public/definitions/agent.js";
export {
  createSession,
  type EmbeddedSession,
  type EmbeddedSessionOptions,
} from "#embed/session.js";
export type { SessionSnapshot } from "#execution/in-process/snapshot.js";
export type { RuntimeWorld } from "#execution/world/runtime-world.js";
export { memoryWorld } from "#execution/world/memory-world.js";
export type { Definition } from "#definitions/definition.js";
export { eve, type EveDefaultsOptions } from "#definitions/defaults.js";
export { memorySandbox, type MemorySandboxOptions } from "#runtime/sandbox/memory-sandbox.js";
export { MemorySandbox, type MemorySandboxEnvironment } from "#sandbox/providers/memory.js";
export { indexedDbWorld } from "./indexed-db-world.js";
export { createIndexedDbSandboxFileStore } from "./sandbox-files.js";
export {
  createMemorySandboxFileStore,
  type SandboxFileEntry,
  type SandboxFileStore,
} from "#execution/sandbox/memory-files.js";
export { defineTool } from "#tools/definition.js";
export { always, never } from "#tools/approval/policies.js";
