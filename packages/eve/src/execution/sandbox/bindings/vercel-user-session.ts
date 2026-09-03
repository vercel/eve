import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type {
  VercelSandbox,
  VercelSandboxUser,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxSeedFile } from "#public/definitions/sandbox-backend.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";

const VERCEL_SANDBOX_USER = "vercel-sandbox";

export function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
): InternalSandboxSession {
  const user = getVercelSandboxUser(sandbox);
  return {
    id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await user.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.stream,
      });
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(
        await user.readFile({ path: options.path }, { signal: options.abortSignal }),
      );
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      await user.writeFiles([{ content: bytes, path: options.path }], {
        signal: options.abortSignal,
      });
    },
    async removePath(options: SandboxRemovePathOptions) {
      const flags = `${options.recursive === true ? "r" : ""}${options.force === true ? "f" : ""}`;
      const result = await user.runCommand({
        args: [...(flags.length > 0 ? [`-${flags}`] : []), "--", options.path],
        cmd: "rm",
        signal: options.abortSignal,
      });
      await expectVercelCommandSuccess(result, `remove "${options.path}" from sandbox`);
    },
  };
}

export async function writeVercelSandboxSeedFiles(input: {
  readonly sandbox: VercelSandbox;
  readonly seedFiles: ReadonlyArray<SandboxSeedFile>;
  readonly session: SandboxSession;
}): Promise<void> {
  if (input.seedFiles.length === 0) {
    return;
  }

  const files = await Promise.all(
    input.seedFiles.map(async (file) => ({
      content: typeof file.content === "string" ? Buffer.from(file.content) : file.content,
      path: await resolveSandboxModelPath({
        path: file.path,
        sandbox: input.session,
      }),
    })),
  );

  await getVercelSandboxUser(input.sandbox).writeFiles(files);
}

function getVercelSandboxUser(sandbox: VercelSandbox): VercelSandboxUser {
  return sandbox.asUser(VERCEL_SANDBOX_USER);
}

async function expectVercelCommandSuccess(
  result: Awaited<ReturnType<VercelSandboxUser["runCommand"]>>,
  description: string,
): Promise<void> {
  if (result.exitCode === 0) {
    return;
  }

  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  throw new Error(`Failed to ${description}.${output ? `\n${output}` : ""}`);
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}
