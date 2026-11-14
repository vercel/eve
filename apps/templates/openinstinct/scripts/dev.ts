import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeProject = `open-instinct-${createHash("sha256")
  .update(repositoryRoot)
  .digest("hex")
  .slice(0, 12)}`;
const composeArguments = (...args: string[]) => [
  "compose",
  "--project-name",
  composeProject,
  ...args,
];

// oxlint-disable-next-line eslint/no-restricted-properties -- the development supervisor must forward the caller's environment to its child processes
const inheritedEnvironment = { ...process.env };

function developmentEnvironment(port: string) {
  const localDatabaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/open_instinct`;
  return {
    ...inheritedEnvironment,
    DATABASE_URL: localDatabaseUrl,
    DATABASE_URL_UNPOOLED: localDatabaseUrl,
  };
}

async function resolvePostgresPort() {
  const output = await runForOutput(
    "docker",
    composeArguments("port", "postgres", "5432")
  );
  if (output === undefined) return undefined;
  const port = /:(\d+)$/.exec(output.trim())?.[1];
  if (!port) {
    throw new Error("Could not resolve the local PostgreSQL port.");
  }
  return port;
}

let activeChild: ChildProcess | undefined;
let composeAttempted = false;
let shutdownSignal: NodeJS.Signals | undefined;

function interrupt(child: ChildProcess, signal: NodeJS.Signals) {
  const childPid = child.pid;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }

    if (childPid === undefined) {
      throw new Error(
        "Cannot forward a signal before the child process starts."
      );
    }
    process.kill(-childPid, signal);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      console.error(
        `Failed to forward ${signal} to ${String(childPid)}:`,
        error
      );
      process.exitCode = 1;
    }
  }
}

const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of shutdownSignals) {
  process.on(signal, () => {
    if (shutdownSignal === undefined) {
      shutdownSignal = signal;
      if (activeChild !== undefined) {
        interrupt(activeChild, signal);
      }
    }
  });
}

async function run(
  command: string,
  args: string[],
  {
    allowInterruption = false,
    env = inheritedEnvironment,
  }: {
    allowInterruption?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env,
    stdio: "inherit",
  });
  activeChild = child;

  try {
    const code = await childExitCode(child);

    if (code !== 0 && !(allowInterruption && shutdownSignal !== undefined)) {
      throw new Error(
        `${command} ${args.join(" ")} exited with ${String(code)}`
      );
    }

    return code === 0 && shutdownSignal === undefined;
  } finally {
    if (activeChild === child) {
      activeChild = undefined;
    }
  }
}

async function runForOutput(command: string, args: string[]) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: inheritedEnvironment,
    stdio: ["inherit", "pipe", "inherit"],
  });
  activeChild = child;
  child.stdout.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });

  try {
    const code = await childExitCode(child);
    if (code !== 0 && shutdownSignal === undefined) {
      throw new Error(
        `${command} ${args.join(" ")} exited with ${String(code)}`
      );
    }
    return shutdownSignal === undefined ? output : undefined;
  } finally {
    if (activeChild === child) {
      activeChild = undefined;
    }
  }
}

function childExitCode(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

function requireKernelApiKey() {
  if (inheritedEnvironment.KERNEL_API_KEY?.trim()) return;

  throw new Error(
    [
      "KERNEL_API_KEY is required for manual local development.",
      "For the simplest setup, use the Deploy with Vercel button in README.md; its Kernel Marketplace integration supplies the credentials automatically.",
      "For an existing linked Vercel project, run pnpm exec vercel integration add kernel --plan FREE.",
      "Otherwise create a key at https://kernel.sh, set KERNEL_API_KEY in .env.local, and run pnpm dev again.",
    ].join("\n")
  );
}

try {
  requireKernelApiKey();
  composeAttempted = true;
  let shouldContinue = await run(
    "docker",
    composeArguments("up", "--detach", "--wait"),
    { allowInterruption: true }
  );

  if (shouldContinue) {
    const port = await resolvePostgresPort();
    if (port !== undefined) {
      const environment = developmentEnvironment(port);
      shouldContinue = await run("pnpm", ["db:migrate"], {
        allowInterruption: true,
        env: environment,
      });

      if (shouldContinue) {
        await run("pnpm", ["dev:app"], {
          allowInterruption: true,
          env: environment,
        });
      }
    }
  }
} finally {
  if (composeAttempted) {
    await run("docker", composeArguments("down"));
  }
}
