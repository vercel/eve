// The embed API every host has: agents defined in code, sessions with them and the Worlds that
// keep them, and eve's default tools with an in-memory sandbox. `eve/experimental/embed` (Node) and
// `eve/browser` each re-export this list and add what only their host has, so the two can't drift.
// Nothing here may reach a Node built-in: `scripts/browser-reach.mjs` measures `eve/browser`.
export {
  defineAgent,
  type AgentContentsDefinition,
  type AgentDefinition,
  type DefinedAgent,
} from "#public/definitions/agent.js";
export type { Definition } from "#definitions/definition.js";
export { defineContext } from "#embed/agent.js";
export {
  createSession,
  type EmbeddedSession,
  type EmbeddedSessionOptions,
} from "#embed/session.js";
export { listSessions, type SavedSession } from "#embed/sessions.js";
export type { SessionSnapshot } from "#execution/in-process/snapshot.js";
// Where sessions are kept: any Workflow World, or this process's memory (the default).
export type { RuntimeWorld as World } from "#execution/world/runtime-world.js";
export { memoryWorld } from "#execution/world/memory-world.js";
// eve's default tools, and the sandbox that runs them in memory (just-bash): in a browser its
// files persist in IndexedDB, elsewhere they last as long as the process.
export { eve, type EveDefaultsOptions } from "#definitions/defaults.js";
export { memorySandbox, type MemorySandboxOptions } from "#runtime/sandbox/memory-sandbox.js";
