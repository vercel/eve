import { type Command, InvalidArgumentError } from "#compiled/commander/index.js";
import {
  parseDevelopmentHeaderOption,
  resolveDevelopmentUrlTarget,
  type DevelopmentRequestHeaders,
} from "#cli/dev/url-target.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";
import type { DevelopmentTarget } from "#services/dev-client/target.js";

import { resolveInvokeOperation, type RunInvokeInput } from "./invoke.js";
import { invokeResultJsonSchema, parseInvokeResumeInput, type InvokeResult } from "./result.js";

interface InvokeCliOptions {
  header?: DevelopmentRequestHeaders;
  jsonSchema?: boolean;
  resume?: boolean;
  scope?: string;
  url?: string;
}

export interface InvokeCommandDependencies {
  readonly loadEnvironment: (appRoot: string) => void | Promise<void>;
  readonly runInvoke: (input: RunInvokeInput) => Promise<InvokeResult>;
  readonly startHost: (appRoot: string) => DevelopmentServer | Promise<DevelopmentServer>;
}

/** Runtime overrides used when wiring `eve invoke` into the root CLI. */
export interface InvokeCliRuntimeDependencies {
  readonly runInvoke: (input: RunInvokeInput) => Promise<InvokeResult>;
  readonly startHost: (appRoot: string, options?: DevelopmentServerOptions) => DevelopmentServer;
}

interface InvokeCommandLogger {
  log(message: string): void;
}

/** Registers the invoke command with lazily loaded production dependencies. */
export function registerRuntimeInvokeCommand(input: {
  readonly appRoot: string;
  readonly logger: InvokeCommandLogger;
  readonly program: Command;
  readonly runtime: Partial<InvokeCliRuntimeDependencies>;
}): void {
  registerInvokeCommand({
    ...input,
    deps: {
      loadEnvironment: async (root) =>
        (await import("#cli/dev/environment.js")).loadDevelopmentEnvironmentFiles(root),
      runInvoke: async (invokeInput) =>
        await (input.runtime.runInvoke ?? (await import("./invoke.js")).runInvoke)(invokeInput),
      startHost: async (root) =>
        (
          input.runtime.startHost ??
          (await import("#internal/nitro/host.js")).createDevelopmentServer
        )(root, { existing: "reject" }),
    },
  });
}

/** Registers the non-interactive invoke command. */
export function registerInvokeCommand(input: {
  readonly appRoot: string;
  readonly deps: InvokeCommandDependencies;
  readonly logger: InvokeCommandLogger;
  readonly program: Command;
}): void {
  input.program
    .command("invoke")
    .description("Invoke an eve agent without a terminal UI.")
    .argument("[prompt]", "Prompt, follow-up message, or answer to a pending input")
    .option("-u, --url <url>", "Invoke an existing server URL", parseDevelopmentServerUrl)
    .option(
      "-H, --header <header>",
      'Request header for a URL target, in "Name: value" form (repeatable)',
      parseDevelopmentHeaderOption,
    )
    .option("--resume", "Read a previous resumable result from stdin")
    .option("--scope <team>", "Vercel team that owns the URL target")
    .option("--json-schema", "Print the invoke result JSON Schema and exit")
    .action((prompt: string | undefined, options: InvokeCliOptions) =>
      runInvokeCommand({ ...input, options, prompt }),
    );
}

async function runInvokeCommand(input: {
  readonly appRoot: string;
  readonly deps: InvokeCommandDependencies;
  readonly logger: InvokeCommandLogger;
  readonly options: InvokeCliOptions;
  readonly prompt?: string;
}): Promise<void> {
  const { options } = input;
  if (options.jsonSchema === true) {
    assertSchemaOnly(input.prompt, options);
    input.logger.log(JSON.stringify(invokeResultJsonSchema, null, 2));
    return;
  }
  const previous =
    options.resume === true ? parseInvokeResumeInput(await readJsonFromStdin()) : undefined;
  const resumedTarget = previous?.resume.target;
  if (resumedTarget?.kind === "local" && options.url !== undefined) {
    throw new InvalidArgumentError("A local invocation cannot be resumed against --url.");
  }

  const effectiveUrl =
    options.url ?? (resumedTarget?.kind === "remote" ? resumedTarget.serverUrl : undefined);
  const remoteTarget = resolveDevelopmentUrlTarget(
    { header: options.header, url: effectiveUrl },
    undefined,
  );
  if (options.scope !== undefined && remoteTarget === undefined) {
    throw new InvalidArgumentError("The --scope option requires a URL target.");
  }
  if (
    resumedTarget?.kind === "remote" &&
    options.url !== undefined &&
    remoteTarget !== undefined &&
    remoteTarget.serverUrl !== resumedTarget.serverUrl
  ) {
    throw new InvalidArgumentError(
      `Session target ${resumedTarget.serverUrl} does not match ${remoteTarget.serverUrl}.`,
    );
  }
  const operation = resolveInvokeOperation({ previous, prompt: input.prompt });

  await input.deps.loadEnvironment(input.appRoot);
  if (remoteTarget !== undefined) {
    await executeWithSignals(
      input,
      {
        kind: "remote",
        serverUrl: remoteTarget.serverUrl,
        workspaceRoot: input.appRoot,
      },
      remoteTarget.headers,
      operation,
      options.scope,
    );
    return;
  }

  const server = await input.deps.startHost(input.appRoot);
  try {
    const handle = await server.start();
    await executeWithSignals(
      input,
      { kind: "local", serverUrl: handle.url, workspaceRoot: handle.appRoot },
      undefined,
      operation,
    );
  } finally {
    await server.close();
  }
}

async function executeWithSignals(
  input: {
    readonly deps: InvokeCommandDependencies;
    readonly logger: InvokeCommandLogger;
    readonly options: InvokeCliOptions;
  },
  target: DevelopmentTarget,
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

function assertSchemaOnly(prompt: string | undefined, options: InvokeCliOptions): void {
  if (
    prompt !== undefined ||
    options.resume === true ||
    options.scope !== undefined ||
    options.url !== undefined ||
    options.header !== undefined
  ) {
    throw new InvalidArgumentError(
      "--json-schema cannot be combined with invoke options or a prompt.",
    );
  }
}

async function readJsonFromStdin(): Promise<unknown> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  if (text.trim().length === 0) {
    throw new InvalidArgumentError("--resume expected a resumable eve invoke result on stdin.");
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
