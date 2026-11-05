/**
 * Experimental: agents defined in code, run in this process. An agent is `defineAgent({ ... })`,
 * the function `agent.ts` uses, with the contents of an `agent/` directory as fields (`tools`,
 * `instructions`, `subagents`, ...). `createSession` runs one conversation with it here, with the
 * session loop, approvals and stream a deployed agent has. A session is a run on a World, which
 * keeps it as it runs (`localWorld()` for a directory), so `resume` continues it in another
 * process. `eve/experimental/embed/terminal` serves an agent to `eve dev`'s
 * terminal UI. APIs may change without notice.
 *
 * What stable entries already export isn't repeated here: `defineTool` (`eve/tools`), `always` and
 * `never` (`eve/tools/approval`), skills and instructions (`eve/skills`, `eve/instructions`), and
 * sandbox environments such as `DockerSandbox` (`eve/sandbox/docker`).
 */
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
export { localUser } from "#embed/local-user.js";
export { listSessions, type SavedSession } from "#embed/sessions.js";
export type { SessionSnapshot } from "#execution/in-process/snapshot.js";
// Where sessions are kept: Workflow's local World in a directory, a Vercel project's World, so
// sessions continue on any machine, or this process's memory.
export type { RuntimeWorld as World } from "#execution/world/runtime-world.js";
export { localWorld, type LocalWorldOptions } from "#execution/world/local-world.js";
export { vercelWorld, type VercelWorldOptions } from "#execution/world/vercel-world.js";
export { memoryWorld } from "#execution/world/memory-world.js";
// eve's default tools, and the sandboxes they run in.
export { eve, type EveDefaultsOptions } from "#definitions/defaults.js";
export { memorySandbox, type MemorySandboxOptions } from "#runtime/sandbox/memory-sandbox.js";
export { hostSandbox } from "#runtime/sandbox/host-sandbox.js";
export type { HostSandboxOptions } from "#sandbox/providers/host.js";
export { codeSandbox, type CodeSandboxOptions } from "#runtime/sandbox/code-sandbox.js";
export type { CodeSandbox } from "#runtime/sandbox/code-sandbox-registry.js";
