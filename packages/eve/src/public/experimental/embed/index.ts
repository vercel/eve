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
export * from "#public/experimental/embed/shared.js";
// What a Node host adds: its user, sessions kept on disk, and sandboxes on the host or in any
// other environment.
export { localUser } from "#embed/local-user.js";
// Where a Node process keeps sessions: Workflow's local World in a directory, or a Vercel
// project's World, so sessions continue on any machine.
export { localWorld, type LocalWorldOptions } from "#execution/world/local-world.js";
export { vercelWorld, type VercelWorldOptions } from "#execution/world/vercel-world.js";
export { hostSandbox } from "#runtime/sandbox/host-sandbox.js";
export type { HostSandboxOptions } from "#sandbox/providers/host.js";
export { codeSandbox, type CodeSandboxOptions } from "#runtime/sandbox/code-sandbox.js";
export type { CodeSandbox } from "#runtime/sandbox/code-sandbox-registry.js";
