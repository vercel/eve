import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createCodex } from "@ai-sdk/harness-codex";
import type { Agent, AgentRunResult } from "@vercel/agent-eval";

import type {
  AuthoringCase,
  AuthoringSetup,
  AuthoringSetupContext,
  AuthoringTurn,
} from "./authoring-case.js";
import { createDependencyCachedSandbox } from "./dependency-sandbox.js";
import {
  AGENT_EVAL_DIRECTORY,
  AUTHORING_EVAL_DIRECTORY,
  AUTHORING_EVAL_DIRECTORY_ENV,
  AUTHORING_MODEL,
  EVE_PACKAGE_PATH,
  SOURCE_ARCHIVE_PATH,
  SOURCE_ROOT,
  WORKSPACE,
  WORKSPACE_ENV,
} from "./paths.js";
import type { AuthoringTranscriptEntry } from "./protocol.js";

const HARNESS_BRIDGE_PORT = 4172;
const HARNESS_NAME = "codex";
export function createAuthoringAgent(subject: {
  readonly name: string;
  readonly archive: Uint8Array;
  readonly digest: string;
  readonly dependencyDigest: string;
}): Agent {
  return {
    name: subject.name,
    displayName: "eve authoring harness",
    getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
    getDefaultModel: () => AUTHORING_MODEL,
    definition: {
      name: subject.name,
      displayName: "eve authoring harness",
      defaultModel: AUTHORING_MODEL,
      o11yAgentName: HARNESS_NAME,
      runnerPath: "",
      getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
      install: () => [],
      configFiles: () => [],
      authEnv: () => ({}),
    },
    async run(fixturePath, options): Promise<AgentRunResult> {
      const verbose = options.agentOptions?.verbose === true;
      const log = (message: string) => {
        if (verbose) console.log(message);
      };
      const authoringCase = await loadAuthoringCase(fixturePath);
      const setups = [authoringCase.startingPoint.setup, authoringCase.setup].filter(
        (setup): setup is AuthoringSetup => setup !== undefined,
      );
      const sandbox = createDependencyCachedSandbox({
        archive: subject.archive,
        dependencyDigest: subject.dependencyDigest,
        ports: [HARNESS_BRIDGE_PORT, ...new Set(setups.flatMap((setup) => setup.ports ?? []))],
        env: {
          EVE_INIT_PACKAGE_SPEC: EVE_PACKAGE_PATH,
          [AUTHORING_EVAL_DIRECTORY_ENV]: AUTHORING_EVAL_DIRECTORY,
          ...Object.assign({}, ...setups.map((setup) => setup.environment ?? {})),
        },
        log,
      });
      const startedAt = Date.now();
      const commands: string[] = [];
      const transcript: AuthoringTranscriptEntry[] = [];
      let session: HarnessAgentSession | undefined;
      let activeSandbox: HarnessV1NetworkSandboxSession | undefined;
      let workspace: string | undefined;

      const harnessOptions: Parameters<typeof createCodex>[0] = {
        auth: { gateway: { apiKey: options.apiKey } },
        reasoningEffort: "high",
        port: HARNESS_BRIDGE_PORT,
      };
      if (options.model !== undefined) Object.assign(harnessOptions, { model: options.model });

      const agent = new HarnessAgent({
        id: "eve-benchmark",
        harness: createCodex(harnessOptions),
        sandbox,
        sandboxConfig: {
          workDir: WORKSPACE,
          bootstrapHash: bootstrapHash(authoringCase, subject),
          onBootstrap: async ({ session: bootstrap, workDir }) => {
            log("[setup] building the selected eve source");
            const networkSandbox = bootstrap as HarnessV1NetworkSandboxSession;
            await bootstrapSubject(
              networkSandbox,
              workDir,
              authoringCase.startingPoint.workspace,
              subject.archive,
            );
            const context = setupContext(networkSandbox, workDir);
            for (const setup of setups) await setup.onBootstrap?.(context);
          },
          onSession: async ({ session: current, sessionWorkDir }) => {
            log("[setup] preparing the benchmark session");
            activeSandbox = current as HarnessV1NetworkSandboxSession;
            workspace = sessionWorkDir;
            const context = setupContext(activeSandbox, workspace);
            for (const setup of setups) await setup.onSession?.(context);
            if (options.agentOptions?.agentsMd === true) {
              await assertAgentGuidance(context);
            } else {
              await context.run("rm -f AGENTS.md CLAUDE.md");
            }
            await context.write(
              `${AGENT_EVAL_DIRECTORY}/results.json`,
              JSON.stringify({ o11y: { shellCommands: [] } }),
            );
          },
        },
        permissionMode: "allow-all",
      });

      try {
        session = await withBootstrapInitialization(bootstrapHash(authoringCase, subject), () =>
          agent.createSession({ abortSignal: options.signal }),
        );
        if (activeSandbox === undefined || workspace === undefined) {
          throw new Error("HarnessAgent did not initialize its sandbox session.");
        }

        await authoringCase.interact({
          session,
          transcript,
          send: async (prompt) => {
            transcript.push({ role: "user", content: prompt });
            if (verbose) console.log(`[user] ${prompt}`);
            const result = verbose
              ? await streamTurn(agent, session!, prompt, options.timeout, options.signal)
              : await agent.generate({
                  session: session!,
                  prompt,
                  timeout: options.timeout,
                  abortSignal: options.signal,
                });
            transcript.push({ role: "assistant", content: result.text });
            commands.push(...shellCommands(result.toolCalls));
            return { text: result.text, toolCalls: result.toolCalls };
          },
        });

        const context = setupContext(activeSandbox, workspace);
        await context.write(
          `${AGENT_EVAL_DIRECTORY}/results.json`,
          JSON.stringify({ o11y: { shellCommands: commands.map((command) => ({ command })) } }),
        );
        await context.write(
          `${AGENT_EVAL_DIRECTORY}/harness-transcript.json`,
          JSON.stringify(transcript),
        );
        await Promise.all([
          context.write(
            `${AGENT_EVAL_DIRECTORY}/EVAL.test.ts`,
            readFileSync(`${fixturePath}/EVAL.ts`, "utf8"),
          ),
          context.write(
            `${AGENT_EVAL_DIRECTORY}/grader.ts`,
            readFileSync(new URL("./grader.ts", import.meta.url), "utf8"),
          ),
          context.write(
            `${AGENT_EVAL_DIRECTORY}/paths.ts`,
            readFileSync(new URL("./paths.ts", import.meta.url), "utf8"),
          ),
          context.write(
            `${AGENT_EVAL_DIRECTORY}/protocol.ts`,
            readFileSync(new URL("./protocol.ts", import.meta.url), "utf8"),
          ),
        ]);

        log("[grade] running deterministic assertions");
        const test = await resultOf(
          activeSandbox,
          `cd ${AGENT_EVAL_DIRECTORY} && ${WORKSPACE_ENV}=${shellQuote(workspace)} vitest run EVAL.test.ts`,
          workspace,
        );
        const scriptsResults = Object.fromEntries(
          await Promise.all(
            (options.scripts ?? []).map(async (script) => {
              log(`[${script}] running`);
              const result = await resultOf(
                activeSandbox!,
                `npm run ${shellQuote(script)}`,
                workspace,
              );
              return [
                script,
                { success: result.exitCode === 0, output: `${result.stdout}${result.stderr}` },
              ] as const;
            }),
          ),
        );
        const scriptsPassed = Object.values(scriptsResults).every((result) => result.success);
        log(`[result] ${test.exitCode === 0 && scriptsPassed ? "passed" : "failed"}`);
        return {
          success: test.exitCode === 0 && scriptsPassed,
          output: transcript.at(-1)?.content ?? "",
          transcript: JSON.stringify(transcript),
          error:
            test.exitCode === 0 && scriptsPassed ? undefined : `${test.stdout}\n${test.stderr}`,
          duration: Date.now() - startedAt,
          testResult: { success: test.exitCode === 0, output: `${test.stdout}${test.stderr}` },
          scriptsResults,
          sandboxId: activeSandbox.id,
        };
      } catch (error) {
        if (activeSandbox !== undefined && workspace !== undefined) {
          await setupContext(activeSandbox, workspace)
            .write(`${AGENT_EVAL_DIRECTORY}/harness-transcript.json`, JSON.stringify(transcript))
            .catch(() => undefined);
        }
        const result: AgentRunResult = {
          success: false,
          output: transcript.at(-1)?.content ?? "",
          transcript: JSON.stringify(transcript),
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startedAt,
          scriptsResults: {},
        };
        if (activeSandbox !== undefined) {
          Object.assign(result, { sandboxId: activeSandbox.id });
        }
        return result;
      } finally {
        await session?.destroy();
      }
    },
  };
}

async function streamTurn(
  agent: HarnessAgent,
  session: HarnessAgentSession,
  prompt: string,
  timeout: number,
  abortSignal?: AbortSignal,
): Promise<AuthoringTurn> {
  const result = await agent.stream({ session, prompt, timeout, abortSignal });
  let lineOpen = false;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      if (!lineOpen) {
        process.stdout.write("[assistant] ");
        lineOpen = true;
      }
      process.stdout.write(part.text);
    } else if (part.type === "tool-call") {
      if (lineOpen) process.stdout.write("\n");
      lineOpen = false;
      console.log(`[tool] ${formatToolCall(part.toolName, part.input)}`);
    }
  }
  if (lineOpen) process.stdout.write("\n");
  return { text: await result.text, toolCalls: await result.toolCalls };
}

function formatToolCall(name: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return `${name} ${JSON.stringify(input)}`;
}

async function bootstrapSubject(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
  workspaceKind: "scaffolded" | "empty",
  archive: Uint8Array,
): Promise<void> {
  await sandbox.writeBinaryFile({ path: SOURCE_ARCHIVE_PATH, content: archive });
  await run(
    sandbox,
    [
      `rm -rf ${SOURCE_ROOT} && mkdir -p ${SOURCE_ROOT}`,
      `tar -xzf ${SOURCE_ARCHIVE_PATH} -C ${SOURCE_ROOT}`,
      `pnpm --dir ${SOURCE_ROOT} install --frozen-lockfile --offline`,
      `pnpm --dir ${SOURCE_ROOT} --filter eve build`,
      "mkdir -p /tmp/eve-package",
      `pnpm --dir ${SOURCE_ROOT}/packages/eve pack --pack-destination /tmp/eve-package`,
      `mv $(find /tmp/eve-package -name '*.tgz' -print -quit) ${EVE_PACKAGE_PATH}`,
      `npm install --global --package-lock=false ${EVE_PACKAGE_PATH}`,
    ].join(" && "),
  );
  const artifactsRoot = AGENT_EVAL_DIRECTORY;
  const workspaceCommands: string[] = [];
  if (workspaceKind === "scaffolded") {
    workspaceCommands.push(`cd ${shellQuote(workspace)} && AI_AGENT=benchmark eve init .`);
  }
  workspaceCommands.push(
    `mkdir -p ${artifactsRoot}`,
    `printf '{"private":true,"type":"module"}\\n' >${artifactsRoot}/package.json`,
    "command -v vitest >/dev/null",
  );
  if (workspaceKind === "scaffolded") {
    workspaceCommands.push(`test -f ${workspace}/package.json`);
  }
  await run(sandbox, workspaceCommands.join(" && "));
}

function setupContext(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
): AuthoringSetupContext {
  return {
    sandbox,
    workspace,
    artifactsRoot: AUTHORING_EVAL_DIRECTORY,
    run: async (command, workingDirectory = workspace) => {
      await run(sandbox, command, workingDirectory);
    },
    write: async (path, content) => {
      await sandbox.writeTextFile({
        path: path.startsWith("/") ? path : `${workspace}/${path}`,
        content,
      });
    },
  };
}

async function assertAgentGuidance(context: AuthoringSetupContext): Promise<void> {
  await context.run("test -s AGENTS.md && test -s CLAUDE.md && grep -Fq '@AGENTS.md' CLAUDE.md");
}

function shellCommands(toolCalls: ReadonlyArray<{ input: unknown }>): string[] {
  return toolCalls.flatMap((call) => {
    if (typeof call.input !== "object" || call.input === null) return [];
    const command = (call.input as { command?: unknown }).command;
    return typeof command === "string" ? [command] : [];
  });
}

function bootstrapHash(authoringCase: AuthoringCase, subject: { readonly digest: string }): string {
  const setupIds = [authoringCase.startingPoint.setup, authoringCase.setup]
    .filter((setup): setup is AuthoringSetup => setup !== undefined)
    .map((setup) => setup.id)
    .join("-");
  return `eve-authoring-${subject.digest}-${authoringCase.startingPoint.id}-${setupIds}`;
}

const bootstrapCoordination = globalThis as typeof globalThis & {
  __eveAuthoringBootstrapLocks?: Map<string, Promise<void>>;
  __eveAuthoringBootstrapsReady?: Set<string>;
};

async function withBootstrapInitialization<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const ready = (bootstrapCoordination.__eveAuthoringBootstrapsReady ??= new Set());
  if (ready.has(key)) return operation();

  const locks = (bootstrapCoordination.__eveAuthoringBootstrapLocks ??= new Map());
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);

  await previous;
  try {
    const result = await operation();
    ready.add(key);
    return result;
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function loadAuthoringCase(fixturePath: string): Promise<AuthoringCase> {
  let loaded: unknown = await import(pathToFileURL(`${fixturePath}/CASE.ts`).href);
  while (!isAuthoringCase(loaded) && hasDefaultExport(loaded)) loaded = loaded.default;
  if (!isAuthoringCase(loaded)) {
    throw new Error(`${fixturePath}/CASE.ts must export an authoring case as default.`);
  }
  return loaded;
}

function isAuthoringCase(value: unknown): value is AuthoringCase {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthoringCase>;
  return candidate.startingPoint !== undefined && typeof candidate.interact === "function";
}

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return typeof value === "object" && value !== null && "default" in value;
}

async function resultOf(
  sandbox: HarnessV1NetworkSandboxSession,
  command: string,
  workingDirectory?: string,
) {
  const options: Parameters<typeof sandbox.run>[0] = { command };
  if (workingDirectory !== undefined) Object.assign(options, { workingDirectory });
  return sandbox.run(options);
}

async function run(
  sandbox: HarnessV1NetworkSandboxSession,
  command: string,
  workingDirectory?: string,
): Promise<void> {
  const result = await resultOf(sandbox, command, workingDirectory);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
