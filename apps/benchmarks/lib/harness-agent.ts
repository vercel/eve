import { readFileSync } from "node:fs";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import type { Agent, AgentRunResult } from "@vercel/agent-eval";

import type {
  AuthoringCase,
  AuthoringSetup,
  AuthoringSetupContext,
  AuthoringTurn,
} from "./authoring-case.js";
import { createDependencyCachedSandbox } from "./dependency-sandbox.js";
import { loadAuthoringCase } from "./load-authoring-case.js";
import {
  AGENT_EVAL_DIRECTORY,
  AUTHORING_EVAL_DIRECTORY,
  AUTHORING_EVAL_DIRECTORY_ENV,
  EVE_PACKAGE_PATH,
  SOURCE_ARCHIVE_PATH,
  SOURCE_ROOT,
  WORKSPACE,
} from "./paths.js";
import type { AuthoringTokenUsage, AuthoringTranscriptEntry } from "./protocol.js";
import { BenchmarkTimings } from "./timing.js";

const HARNESS_BRIDGE_PORT = 4172;
const BOOTSTRAP_VERSION = "v6";
export function createAuthoringAgent(subject: {
  readonly model: string;
  readonly archive: Uint8Array;
  readonly dependencyArchive: Uint8Array;
  readonly digest: string;
  readonly dependencyDigest: string;
}): Agent {
  return {
    name: "opencode",
    displayName: "eve authoring harness",
    getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
    getDefaultModel: () => subject.model,
    definition: {
      name: "opencode",
      displayName: "eve authoring harness",
      defaultModel: subject.model,
      o11yAgentName: "opencode",
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
      const timings = new BenchmarkTimings();
      timings.record("run.context", 0, "success", {
        sourceArchiveBytes: subject.archive.length,
        dependencyArchiveBytes: subject.dependencyArchive.length,
        sourceDigest: subject.digest,
        dependencyDigest: subject.dependencyDigest,
        startingPoint: authoringCase.startingPoint.id,
        setupCount: setups.length,
      });
      const sandbox = createDependencyCachedSandbox({
        archive: subject.archive,
        dependencyArchive: subject.dependencyArchive,
        dependencyDigest: subject.dependencyDigest,
        ports: [HARNESS_BRIDGE_PORT, ...new Set(setups.flatMap((setup) => setup.ports ?? []))],
        env: {
          EVE_INIT_PACKAGE_SPEC: EVE_PACKAGE_PATH,
          [AUTHORING_EVAL_DIRECTORY_ENV]: AUTHORING_EVAL_DIRECTORY,
          ...Object.assign({}, ...setups.map((setup) => setup.environment ?? {})),
        },
        log,
        timings,
      });
      const startedAt = Date.now();
      const commands: string[] = [];
      const transcript: AuthoringTranscriptEntry[] = [];
      let session: HarnessAgentSession | undefined;
      let activeSandbox: HarnessV1NetworkSandboxSession | undefined;
      let workspace: string | undefined;

      const agent = new HarnessAgent({
        id: "eve-authoring-eval",
        harness: createOpenCode({
          auth: "ai-gateway",
          model: openCodeModel(options.model ?? subject.model),
          port: HARNESS_BRIDGE_PORT,
        }),
        sandbox,
        sandboxConfig: {
          workDir: WORKSPACE,
          bootstrapHash: bootstrapHash(authoringCase, subject),
          onBootstrap: async ({ session: bootstrap, workDir }) => {
            const bootstrapSandbox = bootstrap as HarnessV1NetworkSandboxSession;
            const context = setupContext(bootstrapSandbox, workDir);
            await timings.measure("subject.case-bootstrap", async () => {
              for (const setup of setups) await setup.onBootstrap?.(context);
            });
            log("[setup] building the selected eve source");
            await bootstrapSubject(
              bootstrapSandbox,
              workDir,
              authoringCase.startingPoint.workspace,
              subject.archive,
              timings,
            );
          },
          onSession: async ({ session: current, sessionWorkDir }) => {
            activeSandbox = current as HarnessV1NetworkSandboxSession;
            workspace = sessionWorkDir;
            const context = setupContext(activeSandbox, workspace);
            await timings.measure("session.setup", async () => {
              for (const setup of setups) await setup.onSession?.(context);
              if (options.agentOptions?.agentsMd !== true) await installBaselineEveWrapper(context);
            });
            if (options.agentOptions?.agentsMd !== true) {
              await context.run("rm -f AGENTS.md CLAUDE.md GEMINI.md");
            }
          },
        },
        permissionMode: "allow-all",
      });

      try {
        session = await timings.measure("session.create", () =>
          withBootstrapInitialization(bootstrapHash(authoringCase, subject), () =>
            agent.createSession({ abortSignal: options.signal }),
          ),
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
            const turn = transcript.filter((entry) => entry.role === "user").length;
            const result = await timings.measure(`agent.turn.${turn}`, () =>
              verbose
                ? streamTurn(agent, session!, prompt, options.timeout, options.signal)
                : generateTurn(agent, session!, prompt, options.timeout, options.signal),
            );
            const toolCalls = authoringToolCalls(result.toolCalls);
            const usage = normalizeUsage(result.usage);
            transcript.push({ role: "assistant", content: result.text, toolCalls, usage });
            timings.record(`agent.turn.${turn}.summary`, 0, "success", {
              promptCharacters: prompt.length,
              responseCharacters: result.text.length,
              toolCalls: toolCalls.length,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              reasoningTokens: usage.reasoningTokens,
            });
            commands.push(...shellCommands(result.toolCalls));
            return { text: result.text, toolCalls };
          },
        });

        const projectWorkspace =
          authoringCase.projectDirectory === undefined
            ? workspace
            : `${workspace}/${authoringCase.projectDirectory}`;
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
        const test = await timings.measure("validation.grader", () =>
          resultOf(
            activeSandbox!,
            `ln -s ${workspace}/${AGENT_EVAL_DIRECTORY} .eve-grader && trap 'rm -f .eve-grader' EXIT && vitest run .eve-grader/EVAL.test.ts`,
            projectWorkspace,
          ),
        );
        const scriptsResults = Object.fromEntries(
          await Promise.all(
            (options.scripts ?? []).map(async (script) => {
              log(`[${script}] running`);
              const result = await timings.measure(`validation.${script}`, () =>
                resultOf(activeSandbox!, `npm run ${shellQuote(script)}`, projectWorkspace),
              );
              return [
                script,
                { success: result.exitCode === 0, output: `${result.stdout}${result.stderr}` },
              ] as const;
            }),
          ),
        );
        const scriptsPassed = Object.values(scriptsResults).every((result) => result.success);
        timings.record("run.total", Date.now() - startedAt);
        await context.write(
          `${AGENT_EVAL_DIRECTORY}/timings.json`,
          JSON.stringify(timings.entries),
        );
        logTimingSummary(log, timings);
        log(`[result] ${test.exitCode === 0 && scriptsPassed ? "passed" : "failed"}`);
        return {
          success: test.exitCode === 0 && scriptsPassed,
          output: transcript.at(-1)?.content ?? "",
          error:
            test.exitCode === 0 && scriptsPassed ? undefined : `${test.stdout}\n${test.stderr}`,
          duration: Date.now() - startedAt,
          testResult: { success: test.exitCode === 0, output: `${test.stdout}${test.stderr}` },
          transcript: harnessTranscript(transcript),
          scriptsResults,
          sandboxId: activeSandbox.id,
          generatedFiles: timingArtifact(timings),
        };
      } catch (error) {
        timings.record("run.total", Date.now() - startedAt, "failure");
        if (activeSandbox !== undefined && workspace !== undefined) {
          await Promise.all([
            setupContext(activeSandbox, workspace).write(
              `${AGENT_EVAL_DIRECTORY}/harness-transcript.json`,
              JSON.stringify(transcript),
            ),
            setupContext(activeSandbox, workspace).write(
              `${AGENT_EVAL_DIRECTORY}/timings.json`,
              JSON.stringify(timings.entries),
            ),
          ]).catch(() => undefined);
        }
        const result: AgentRunResult = {
          success: false,
          output: transcript.at(-1)?.content ?? "",
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startedAt,
          transcript: harnessTranscript(transcript),
          scriptsResults: {},
          generatedFiles: timingArtifact(timings),
        };
        if (activeSandbox !== undefined) result.sandboxId = activeSandbox.id;
        return result;
      } finally {
        await session?.destroy();
      }
    },
  };
}

async function generateTurn(
  agent: HarnessAgent,
  session: HarnessAgentSession,
  prompt: string,
  timeout: number,
  abortSignal?: AbortSignal,
): Promise<AuthoringTurn & { usage: AuthoringTokenUsage }> {
  const result = await agent.generate({ session, prompt, timeout, abortSignal });
  return {
    text: result.text,
    toolCalls: authoringToolCalls(result.toolCalls),
    usage: normalizeUsage(result.usage),
  };
}

async function streamTurn(
  agent: HarnessAgent,
  session: HarnessAgentSession,
  prompt: string,
  timeout: number,
  abortSignal?: AbortSignal,
): Promise<AuthoringTurn & { usage: AuthoringTokenUsage }> {
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
  return {
    text: await result.text,
    toolCalls: authoringToolCalls(await result.toolCalls),
    usage: normalizeUsage(await result.usage),
  };
}

function openCodeModel(model: string): string {
  const gatewayModel = model.includes("/") ? model : `anthropic/${model}`;
  // OpenCode's Moonshot provider supplies the OpenAI-compatible transport; the
  // canonical model ID still makes AI Gateway select the requested provider.
  return `moonshotai/${gatewayModel}`;
}

function normalizeUsage(value: unknown): AuthoringTokenUsage {
  const usage = value as Record<string, unknown>;
  const number = (field: string) => {
    const value = usage[field];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    reasoningTokens: number("reasoningTokens"),
    cachedInputTokens: number("cachedInputTokens"),
    cacheWriteTokens: number("cacheWriteTokens"),
  };
}

function authoringToolCalls(
  toolCalls: ReadonlyArray<{ name?: string; toolName?: string; input: unknown }>,
): ReadonlyArray<{ name: string; input: unknown }> {
  return toolCalls.flatMap((call) => {
    const name = call.toolName ?? call.name;
    return name === undefined ? [] : [{ name, input: call.input }];
  });
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
  timings: BenchmarkTimings,
): Promise<void> {
  await timings.measure("subject.source-upload", async () => {
    await sandbox.writeBinaryFile({ path: SOURCE_ARCHIVE_PATH, content: archive });
  });
  await timings.measure("subject.source-install", () =>
    run(
      sandbox,
      `rm -rf ${SOURCE_ROOT} && mkdir -p ${SOURCE_ROOT} && tar -xzf ${SOURCE_ARCHIVE_PATH} -C ${SOURCE_ROOT} && pnpm --dir ${SOURCE_ROOT} install --frozen-lockfile --offline`,
    ),
  );
  await timings.measure("subject.eve-build", () =>
    run(sandbox, `pnpm --dir ${SOURCE_ROOT} --filter eve build`),
  );
  await timings.measure("subject.eve-pack-and-cli", () =>
    run(
      sandbox,
      `mkdir -p /tmp/eve-package && pnpm --dir ${SOURCE_ROOT}/packages/eve pack --pack-destination /tmp/eve-package && mv $(find /tmp/eve-package -name '*.tgz' -print -quit) ${EVE_PACKAGE_PATH} && ln -sf ${SOURCE_ROOT}/packages/eve/bin/eve.js /usr/local/bin/eve && command -v eve`,
    ),
  );
  const artifactsRoot = `${workspace}/${AGENT_EVAL_DIRECTORY}`;
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
  await timings.measure("subject.workspace-bootstrap", () =>
    run(sandbox, workspaceCommands.join(" && ")),
  );
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

async function installBaselineEveWrapper(context: AuthoringSetupContext): Promise<void> {
  await context.run(`
cli_path="/usr/local/bin/eve"
test -x "$cli_path"
real_cli="$cli_path.guided"
if [ ! -e "$real_cli" ]; then mv "$cli_path" "$real_cli"; fi
cat >"$cli_path" <<'EOF'
#!/bin/sh
"$0.guided" "$@"
status=$?
rm -f AGENTS.md CLAUDE.md GEMINI.md
exit "$status"
EOF
chmod +x "$cli_path"
`);
}

function timingArtifact(timings: BenchmarkTimings): Record<string, string> {
  return { "benchmark/timings.json": `${JSON.stringify(timings.entries, null, 2)}\n` };
}

function logTimingSummary(log: (message: string) => void, timings: BenchmarkTimings): void {
  for (const timing of timings.entries) {
    log(`[timing] ${timing.phase}: ${timing.durationMs}ms (${timing.outcome})`);
  }
}

function harnessTranscript(transcript: ReadonlyArray<AuthoringTranscriptEntry>): string {
  return transcript
    .map((entry) => {
      const message: {
        role: AuthoringTranscriptEntry["role"];
        content: unknown;
        usage?: AuthoringTokenUsage;
      } = {
        role: entry.role,
        content:
          entry.role === "assistant"
            ? [
                ...(entry.content ? [{ type: "text", text: entry.content }] : []),
                ...(entry.toolCalls ?? []).map((call) => ({
                  type: "tool_use",
                  name: call.name,
                  input: call.input,
                })),
              ]
            : entry.content,
      };
      if (entry.usage !== undefined) message.usage = entry.usage;
      return JSON.stringify({ type: entry.role, message });
    })
    .join("\n");
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
  return `eve-authoring-${BOOTSTRAP_VERSION}-${subject.digest}-${authoringCase.startingPoint.id}-${setupIds}`;
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
  if (ready.has(key)) {
    release();
    if (locks.get(key) === tail) locks.delete(key);
    return operation();
  }
  try {
    const result = await operation();
    ready.add(key);
    return result;
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function resultOf(
  sandbox: HarnessV1NetworkSandboxSession,
  command: string,
  workingDirectory?: string,
) {
  const options: { command: string; workingDirectory?: string } = { command };
  if (workingDirectory !== undefined) options.workingDirectory = workingDirectory;
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
