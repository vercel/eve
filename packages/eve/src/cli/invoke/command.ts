import { type Command, InvalidArgumentError } from "#compiled/commander/index.js";
import type { CliApplicationContext } from "#cli/application-command.js";
import {
  parseDevelopmentHeaderOption,
  resolveDevelopmentUrlTarget,
  type DevelopmentRequestHeaders,
} from "#cli/dev/url-target.js";
import type { RemoteDevelopmentTarget } from "#services/dev-client/target.js";

import { resolveInvokeOperation, type RunInvokeInput } from "./invoke.js";
import { parseInvokeResumeInput, type InvokeResult } from "./result.js";

interface InvokeCliOptions {
  header?: DevelopmentRequestHeaders;
  resume?: boolean;
  scope?: string;
}

export interface InvokeCommandDependencies {
  readonly loadEnvironment: (appRoot: string) => void | Promise<void>;
  readonly runInvoke: (input: RunInvokeInput) => Promise<InvokeResult>;
}

/** Runtime overrides used when wiring `eve remote invoke` into the CLI. */
export interface InvokeCliRuntimeDependencies {
  readonly runInvoke: (input: RunInvokeInput) => Promise<InvokeResult>;
}

interface InvokeCommandLogger {
  log(message: string): void;
}

/** Registers the invoke command with lazily loaded production dependencies. */
export function registerRuntimeInvokeCommand(input: {
  readonly applicationContext: CliApplicationContext;
  readonly logger: InvokeCommandLogger;
  readonly program: Command;
  readonly runtime: Partial<InvokeCliRuntimeDependencies>;
}): void {
  registerInvokeCommand({
    ...input,
    deps: {
      loadEnvironment: async (root) =>
        await (await import("#cli/dev/environment.js")).loadDevelopmentEnvironmentFiles(root),
      runInvoke: async (invokeInput) =>
        await (input.runtime.runInvoke ?? (await import("./invoke.js")).runInvoke)(invokeInput),
    },
  });
}

/** Registers the non-interactive remote invocation command. */
export function registerInvokeCommand(input: {
  readonly applicationContext: CliApplicationContext;
  readonly deps: InvokeCommandDependencies;
  readonly logger: InvokeCommandLogger;
  readonly program: Command;
}): void {
  input.program
    .command("invoke <url> [prompt]")
    .description("Invoke an existing eve agent without a terminal UI.")
    .option(
      "-H, --header <header>",
      'Request header for a URL target, in "Name: value" form (repeatable)',
      parseDevelopmentHeaderOption,
    )
    .option("--resume", "Read a previous resumable result from stdin")
    .option("--scope <team>", "Vercel team that owns the URL target")
    .action((url: string, prompt: string | undefined, options: InvokeCliOptions) =>
      runInvokeCommand({ ...input, options, prompt, url }),
    );
}

async function runInvokeCommand(input: {
  readonly applicationContext: CliApplicationContext;
  readonly deps: InvokeCommandDependencies;
  readonly logger: InvokeCommandLogger;
  readonly options: InvokeCliOptions;
  readonly prompt?: string;
  readonly url: string;
}): Promise<void> {
  const { options } = input;
  const previous =
    options.resume === true ? parseInvokeResumeInput(await readJsonFromStdin()) : undefined;
  const resumedTarget = previous?.resume.target;
  const remoteTarget = resolveDevelopmentUrlTarget(
    { header: options.header, url: input.url },
    undefined,
  )!;
  if (
    resumedTarget?.serverUrl !== undefined &&
    resumedTarget.serverUrl !== remoteTarget.serverUrl
  ) {
    throw new Error(
      `Session target ${resumedTarget.serverUrl} does not match ${remoteTarget.serverUrl}.`,
    );
  }
  const operation = resolveInvokeOperation({ previous, prompt: input.prompt });

  await input.deps.loadEnvironment(input.applicationContext.root);
  await executeWithSignals(
    input,
    {
      kind: "remote",
      serverUrl: remoteTarget.serverUrl,
      workspaceRoot: input.applicationContext.root,
    },
    remoteTarget.headers,
    operation,
    options.scope,
  );
}

async function executeWithSignals(
  input: {
    readonly deps: InvokeCommandDependencies;
    readonly logger: InvokeCommandLogger;
    readonly options: InvokeCliOptions;
  },
  target: RemoteDevelopmentTarget,
  headers: DevelopmentRequestHeaders | undefined,
  operation: RunInvokeInput["operation"],
  vercelScope?: string,
): Promise<void> {
  const controller = new AbortController();
  let signalExitCode: number | undefined;
  const handleSigint = () => {
    signalExitCode = 130;
    controller.abort();
  };
  const handleSigterm = () => {
    signalExitCode = 143;
    controller.abort();
  };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  try {
    const invokeInput =
      headers === undefined
        ? { operation, signal: controller.signal, target }
        : { headers, operation, signal: controller.signal, target };
    const scopedInvokeInput =
      vercelScope === undefined ? invokeInput : { ...invokeInput, vercelScope };
    const result = await input.deps.runInvoke(scopedInvokeInput);
    input.logger.log(JSON.stringify(result, null, 2));
    process.exitCode = signalExitCode ?? invokeExitCode(result);
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}

async function readJsonFromStdin(): Promise<unknown> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  if (text.trim().length === 0) {
    throw new InvalidArgumentError(
      "--resume expected a resumable eve remote invoke result on stdin.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidArgumentError("--resume received invalid JSON on stdin.");
  }
}

function invokeExitCode(result: InvokeResult): number {
  if (
    result.status === "failed" ||
    result.status === "authentication-required" ||
    (result.status === "ready" && result.outcome.status === "failed")
  ) {
    return 1;
  }
  if (result.status === "input-required" || result.status === "authorization-required") return 3;
  return 0;
}
