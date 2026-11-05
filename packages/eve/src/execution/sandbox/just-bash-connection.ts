import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import type {
  JustBashFilesystem,
  JustBashSandboxCreateOptions,
} from "#public/sandbox/just-bash-sandbox.js";
import { SANDBOX_AGENT_ENV, type SandboxConnection } from "#public/sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { dirname } from "node:path";

// One just-bash interpreter over a filesystem, as a sandbox connection: the disk binding's, over a
// session root (`just-bash-runtime.ts`), and the memory sandbox's, over an in-memory filesystem.
// It drives just-bash's `Bash` itself, exactly as just-bash's `Sandbox` wrapper would (`Sandbox` is
// in its Node entry only), so it runs on its browser entry too.

/** What this needs of `just-bash`: its Node and browser entries both have it. */
export type JustBashModule = Pick<typeof import("just-bash"), "Bash" | "defineCommand">;

type JustBashCustomCommands = NonNullable<
  NonNullable<JustBashSandboxCreateOptions["experimental"]>["customCommands"]
>;

/** A connection to an interpreter over `filesystem`, and the interpreter's environment. */
export async function connectJustBash(input: {
  readonly customCommands?: JustBashCustomCommands;
  /** The interpreter's starting environment, such as one a template recorded. */
  readonly env?: Readonly<Record<string, string>>;
  readonly filesystem: JustBashFilesystem;
  readonly justBash: JustBashModule;
}): Promise<{
  readonly connection: SandboxConnection;
  /** The interpreter's environment now. */
  readonly environment: () => Record<string, string>;
}> {
  const { filesystem, justBash } = input;
  const shell = new justBash.Bash({
    cwd: WORKSPACE_ROOT,
    customCommands: [
      // just-bash has no realpath command. Workspace tools need the filesystem's
      // symlink-aware result, not lexical path normalization, for containment.
      justBash.defineCommand("realpath", async (args, context) => {
        const path = args.at(-1);
        if (
          args.length !== 4 ||
          args[0] !== "-e" ||
          args[1] !== "-z" ||
          args[2] !== "--" ||
          !path
        ) {
          return { stdout: "", stderr: "realpath: expected -e -z -- path", exitCode: 2 };
        }
        try {
          const real = await context.fs.realpath(path);
          await context.fs.stat(real);
          return { stdout: real + "\0", stderr: "", exitCode: 0 };
        } catch (error) {
          return { stdout: "", stderr: `realpath: ${String(error)}`, exitCode: 1 };
        }
      }),
      ...(input.customCommands ?? []),
    ],
    env: input.env === undefined ? undefined : { ...input.env },
    fs: filesystem,
    network: {
      dangerouslyAllowFullInternetAccess: true,
    },
  });

  const connection: SandboxConnection = {
    async readFile({ path }) {
      try {
        return await filesystem.readFileBuffer(path);
      } catch (error) {
        if (!(await filesystem.exists(path))) return null;
        throw error;
      }
    },
    async removePath(options) {
      await filesystem.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
      });
    },
    async spawn(options) {
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (options.stdin === true) {
        throw new Error("The just-bash sandbox does not support `stdin` on spawn yet.");
      }
      // The command sits on its own lines so a trailing `# comment` cannot
      // swallow the closing brace. `cd X || exit` would lose cd's error in
      // just-bash, so the braces keep `&&` applying to the whole command.
      const wrapped = `( cd ${shellQuote(options.workingDirectory)} && {\n${options.command}\n} )`;
      // just-bash has no separate `bash` executable — it IS the bash
      // interpreter. The `eval` builtin re-parses its single string
      // argument as a shell line, which is the only way to feed an
      // arbitrary shell command into the object-form `runCommand`
      // (the only form that supports `detached`).
      const command = runDetached(shell, quoteArguments(["eval", wrapped]), {
        // just-bash has no sandbox-level environment for `SANDBOX_AGENT_ENV`, so each command gets it.
        env: { ...SANDBOX_AGENT_ENV, ...options.env },
        signal: options.signal,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.type,
      });
    },
    // An interpreter holds nothing to release.
    async stop() {},
    async writeFiles({ files }) {
      for (const file of files) {
        await filesystem.mkdir(dirname(file.path), { recursive: true });
        await filesystem.writeFile(file.path, file.content);
      }
    },
  };
  return { connection, environment: () => ({ ...shell.getEnv() }) };
}

/** `args` as one shell line, each single-quoted, as just-bash's `Sandbox` joins a command's. */
function quoteArguments(args: readonly string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

type JustBashLog = { readonly data: string; readonly type: "stderr" | "stdout" };

/**
 * `commandLine` running in `shell`, as `Sandbox.runCommand({ detached: true })` runs it: in the
 * interpreter's own working directory, cancelled by `signal` or `kill()`, with its output once it
 * finishes.
 */
function runDetached(
  shell: InstanceType<JustBashModule["Bash"]>,
  commandLine: string,
  options: { readonly env: Record<string, string>; readonly signal?: AbortSignal },
) {
  const { signal } = options;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const result = shell
    .exec(commandLine, { cwd: undefined, env: options.env, signal: controller.signal })
    .finally(() => signal?.removeEventListener("abort", forwardAbort));
  return {
    async kill() {
      controller.abort(new Error("command killed"));
    },
    async *logs(): AsyncGenerator<JustBashLog> {
      const { stderr, stdout } = await result;
      if (stdout) yield { data: stdout, type: "stdout" };
      if (stderr) yield { data: stderr, type: "stderr" };
    },
    async wait() {
      const { exitCode } = await result;
      return { exitCode };
    },
  };
}
