import type {
  SandboxSession,
  SandboxRunOptions,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";

/**
 * Binds one sandbox session to an agent home directory.
 *
 * The physical sandbox and the `/workspace` working tree are shared
 * across agents that inherit a parent sandbox — sharing the files is
 * the point of sharing the sandbox. What is private is the home:
 *
 *   /workspace                ← shared working tree, default cwd (unchanged)
 *   {home}/.agents/skills     ← per-agent skill store
 *   {home}/...                ← per-agent dotfiles, caches, scratch
 *
 * The scope does exactly two things:
 *
 * - `run`/`spawn` export `HOME={home}`, so shell `$HOME`, `~`, and
 *   dotfile writes land in the agent's own home.
 * - `resolvePath` and the file methods rewrite a literal `$HOME/...`
 *   prefix to `{home}/...`, so home-relative conventions such as
 *   `$HOME/.agents/skills` resolve per agent with no path encoding.
 *
 * Relative paths and default working directories are untouched: they
 * resolve against the shared `/workspace` exactly as they do for the
 * sandbox-owning agent.
 */
export function scopeSandboxSessionToAgentHome(
  session: SandboxSession,
  home: string | undefined,
): SandboxSession {
  if (home === undefined) {
    return session;
  }

  const resolvePath = (path: string): string => {
    if (path === "$HOME") return home;
    if (path.startsWith("$HOME/")) return `${home}${path.slice("$HOME".length)}`;
    return session.resolvePath(path);
  };

  const scopeCommandOptions = <T extends SandboxRunOptions | SandboxSpawnOptions>(
    options: T,
  ): T => ({
    ...options,
    env: { HOME: home, ...options.env },
  });

  return {
    id: session.id,
    readBinaryFile: (options) =>
      session.readBinaryFile({ ...options, path: resolvePath(options.path) }),
    readFile: (options) => session.readFile({ ...options, path: resolvePath(options.path) }),
    readTextFile: (options) =>
      session.readTextFile({ ...options, path: resolvePath(options.path) }),
    removePath: (options) => session.removePath({ ...options, path: resolvePath(options.path) }),
    resolvePath,
    run: (options) => session.run(scopeCommandOptions(options)),
    setNetworkPolicy: (policy) => session.setNetworkPolicy(policy),
    spawn: (options) => session.spawn(scopeCommandOptions(options)),
    writeBinaryFile: (options) =>
      session.writeBinaryFile({ ...options, path: resolvePath(options.path) }),
    writeFile: (options) => session.writeFile({ ...options, path: resolvePath(options.path) }),
    writeTextFile: (options) =>
      session.writeTextFile({ ...options, path: resolvePath(options.path) }),
  };
}
