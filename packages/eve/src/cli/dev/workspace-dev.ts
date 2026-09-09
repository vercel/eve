import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { selectWorkspaceAgent } from "#cli/agent-command.js";
import type { DevelopmentCliOptions } from "#cli/dev/command-options.js";
import { runInteractiveDevelopmentUi } from "#cli/dev/run-interactive-ui.js";
import { installShutdownSignal } from "#cli/shutdown.js";
import type { AgentWorkspace } from "#internal/project-context.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { resolveVercelInvocation } from "#setup/primitives/run-vercel.js";

async function hasAuthoredVercelConfig(root: string): Promise<boolean> {
  try {
    await Promise.any([access(join(root, "vercel.json")), access(join(root, "vercel.ts"))]);
    return true;
  } catch {
    return false;
  }
}

async function writeGeneratedWorkspaceConfig(workspace: AgentWorkspace): Promise<string> {
  const projectRoot = workspace.root;
  const assembled = assembleEveVercelServices({
    agents: workspace.members.map((member) => {
      const binary = quoteVercelShellArgument(
        toVercelRelativePath(member.appRoot, resolveEveBinaryPath(member.appRoot)),
      );
      return {
        agent: {
          appRoot: member.appRoot,
          buildCommand: `node ${binary} build`,
          devCommand: `node ${binary} dev --no-ui`,
          name: member.name,
          publicRoutePrefix: `/${member.name}`,
          workspaceMember: true,
        },
        target: {
          hostOutputDirectory: join(projectRoot, ".vercel", "output"),
          projectRoot,
        },
      };
    }),
  });
  await Promise.all(
    assembled.rootDirectories.map((directory) => mkdir(directory, { recursive: true })),
  );
  const directory = await mkdtemp(join(tmpdir(), "eve-workspace-dev-"));
  const path = join(directory, "vercel.json");
  await writeFile(
    path,
    `${JSON.stringify({ routes: assembled.routes, services: assembled.services }, null, 2)}\n`,
  );
  return path;
}

function waitForWorkspaceAgent(input: {
  readonly child: ChildProcess;
  readonly serverUrl: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      input.child.off("error", onError);
      input.child.off("exit", onExit);
      outcome();
    };
    const deadline = setTimeout(
      () => settle(() => reject(new Error(`Timed out waiting for ${input.serverUrl}.`))),
      30_000,
    );
    const onExit = (code: number | null) =>
      settle(() =>
        reject(
          new Error(`vc dev exited before the selected agent started (code ${String(code)}).`),
        ),
      );
    const onError = (error: Error) => settle(() => reject(error));
    const poll = async () => {
      if (input.signal.aborted) {
        settle(resolve);
        return;
      }
      try {
        const response = await fetch(new URL("eve/v1/health", input.serverUrl), {
          signal: input.signal,
        });
        if (response.ok) {
          settle(resolve);
          return;
        }
      } catch {}
      if (!settled) setTimeout(() => void poll(), 200).unref();
    };
    input.child.once("error", onError);
    input.child.once("exit", onExit);
    void poll();
  });
}

/** Run a hostless agent workspace through Vercel's local service router. */
export async function runWorkspaceDevelopment(input: {
  readonly options: DevelopmentCliOptions;
  readonly workspace: AgentWorkspace;
}): Promise<void> {
  const selectedRoot = await selectWorkspaceAgent(input.workspace, input.options.agent, {
    required: true,
  });
  const selected = input.workspace.members.find((member) => member.appRoot === selectedRoot)!;
  const generatedConfig = (await hasAuthoredVercelConfig(input.workspace.root))
    ? undefined
    : await writeGeneratedWorkspaceConfig(input.workspace);
  const host = input.options.host ?? "localhost";
  const port = input.options.port ?? 3000;
  const requestHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const serverUrl = `http://${requestHost}:${port}/${selected.name}/`;
  const args = ["dev", "--local", "--listen", `${host}:${port}`];
  if (generatedConfig !== undefined) args.push("--local-config", generatedConfig);
  const invocation = resolveVercelInvocation(input.workspace.root, args);
  const child = spawn(invocation.command, invocation.commandArgs, {
    cwd: input.workspace.root,
    shell: invocation.shell,
    stdio: "inherit",
  });
  const lifecycle = installShutdownSignal({ onStop: () => child.kill("SIGTERM") });
  try {
    await waitForWorkspaceAgent({ child, serverUrl, signal: lifecycle.signal });
    if (!lifecycle.signal.aborted) {
      await runInteractiveDevelopmentUi({
        applicationRoot: selectedRoot,
        existingLocalServer: false,
        lifecycle,
        options: input.options,
        server: { appRoot: selectedRoot, serverUrl },
      });
    }
  } finally {
    if (child.pid !== undefined && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
    lifecycle.dispose();
    if (generatedConfig !== undefined)
      await rm(dirname(generatedConfig), { force: true, recursive: true });
  }
}
