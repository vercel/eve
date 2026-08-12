import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { Agent, AgentRunResult } from "@vercel/agent-eval";

import type {
  AuthoringCase,
  AuthoringSetup,
  AuthoringSetupContext,
  AuthoringTranscriptEntry,
} from "./authoring-case.js";

const WORKSPACE = "workspace";
const HARNESS_BRIDGE_PORT = 4172;
const SUBJECT_REVISION = requiredEnvironmentVariable("EVE_BENCHMARK_REVISION");
const SUBJECT_REPOSITORY = requiredEnvironmentVariable("EVE_BENCHMARK_REPOSITORY");
const INSTRUCTIONS =
  "Work autonomously in the existing eve project. Use the installed, version-matched eve documentation and registry commands. Prefer non-interactive CLI commands intended for coding agents. Ask the user only for information that genuinely belongs to them.";

export function createAuthoringAgent(): Agent {
  return {
    name: "eve-authoring-harness",
    displayName: "eve authoring harness",
    getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
    getDefaultModel: () => "claude-sonnet-4-6",
    definition: {
      name: "eve-authoring-harness",
      displayName: "eve authoring harness",
      defaultModel: "claude-sonnet-4-6",
      o11yAgentName: "claude-code",
      runnerPath: "",
      getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
      install: () => [],
      configFiles: () => [],
      authEnv: () => ({}),
    },
    async run(fixturePath, options): Promise<AgentRunResult> {
      const authoringCase = await loadAuthoringCase(fixturePath);
      const setups = [authoringCase.startingPoint.setup, authoringCase.setup].filter(
        (setup): setup is AuthoringSetup => setup !== undefined,
      );
      const sandbox = createVercelSandbox({
        runtime: "node24",
        ports: [HARNESS_BRIDGE_PORT, ...new Set(setups.flatMap((setup) => setup.ports ?? []))],
        timeout: 15 * 60_000,
        env: {
          EVE_INIT_PACKAGE_SPEC: "/tmp/eve-package/eve.tgz",
          ...Object.assign({}, ...setups.map((setup) => setup.environment ?? {})),
        },
        networkPolicy: "allow-all",
      });
      const startedAt = Date.now();
      const commands: string[] = [];
      const transcript: AuthoringTranscriptEntry[] = [];
      let session: HarnessAgentSession | undefined;
      let activeSandbox: HarnessV1NetworkSandboxSession | undefined;
      let workspace: string | undefined;

      const agent = new HarnessAgent({
        id: "eve-authoring-eval",
        harness: createClaudeCode({
          auth: { gateway: { apiKey: options.apiKey } },
          ...(options.model === undefined ? {} : { model: options.model }),
          thinking: { type: "adaptive", display: "summarized" },
          port: HARNESS_BRIDGE_PORT,
        }),
        sandbox,
        sandboxConfig: {
          workDir: WORKSPACE,
          bootstrapHash: bootstrapHash(authoringCase),
          onBootstrap: async ({ session: bootstrap, workDir }) => {
            const networkSandbox = bootstrap as HarnessV1NetworkSandboxSession;
            await bootstrapSubject(networkSandbox, workDir, authoringCase.startingPoint.workspace);
            const context = setupContext(networkSandbox, workDir);
            for (const setup of setups) await setup.onBootstrap?.(context);
          },
          onSession: async ({ session: current, sessionWorkDir }) => {
            activeSandbox = current as HarnessV1NetworkSandboxSession;
            workspace = sessionWorkDir;
            const context = setupContext(activeSandbox, workspace);
            for (const setup of setups) await setup.onSession?.(context);
            if (options.agentOptions?.agentsMd !== true) {
              await context.run("rm -f AGENTS.md CLAUDE.md");
            }
            await context.write(
              "__agent_eval__/results.json",
              JSON.stringify({ o11y: { shellCommands: [] } }),
            );
          },
        },
        instructions:
          setups.findLast((setup) => setup.instructions !== undefined)?.instructions ??
          INSTRUCTIONS,
        permissionMode: "allow-all",
      });

      try {
        session = await withBootstrapInitialization(bootstrapHash(authoringCase), () =>
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
            const result = await agent.generate({
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
        if (authoringCase.startingPoint.workspace === "empty") {
          await context.run("npm install --no-save --package-lock=false vitest@4.1.10");
        }
        await context.write(
          "__agent_eval__/results.json",
          JSON.stringify({
            o11y: { shellCommands: commands.map((command) => ({ command, success: true })) },
          }),
        );
        await context.write("__agent_eval__/harness-transcript.json", JSON.stringify(transcript));
        await Promise.all([
          context.write("EVAL.test.ts", readFileSync(`${fixturePath}/EVAL.ts`, "utf8")),
          context.write("grader.ts", readFileSync(new URL("./grader.ts", import.meta.url), "utf8")),
        ]);

        const test = await resultOf(activeSandbox, "vitest run EVAL.test.ts", workspace);
        const scriptsResults = Object.fromEntries(
          await Promise.all(
            (options.scripts ?? []).map(async (script) => {
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
        return {
          success: test.exitCode === 0 && scriptsPassed,
          output: transcript.at(-1)?.content ?? "",
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
            .write("__agent_eval__/harness-transcript.json", JSON.stringify(transcript))
            .catch(() => undefined);
        }
        return {
          success: false,
          output: transcript.at(-1)?.content ?? "",
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startedAt,
          scriptsResults: {},
          ...(activeSandbox === undefined ? {} : { sandboxId: activeSandbox.id }),
        };
      } finally {
        await session?.destroy();
      }
    },
  };
}

async function bootstrapSubject(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
  workspaceKind: "scaffolded" | "empty",
): Promise<void> {
  const commands = [
    `git clone --filter=blob:none --no-checkout ${shellQuote(SUBJECT_REPOSITORY)} /tmp/eve-source`,
    `git -C /tmp/eve-source fetch --depth 1 origin ${shellQuote(SUBJECT_REVISION)}`,
    "git -C /tmp/eve-source checkout --detach FETCH_HEAD",
    "corepack enable",
    "cd /tmp/eve-source",
    "pnpm install --frozen-lockfile",
    "pnpm --filter eve build",
    "mkdir -p /tmp/eve-package",
    "pnpm --dir packages/eve pack --pack-destination /tmp/eve-package",
    "mv $(find /tmp/eve-package -name '*.tgz' -print -quit) /tmp/eve-package/eve.tgz",
    "npm install --global --package-lock=false /tmp/eve-package/eve.tgz vitest@4.1.10",
    `cd ${shellQuote(workspace)}`,
  ];
  if (workspaceKind === "scaffolded") {
    commands.push(
      "AI_AGENT=benchmark eve init .",
      "npm install --save-dev --package-lock=false vitest@4.1.10",
    );
  }
  await run(sandbox, commands.join(" && "));
}

function setupContext(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
): AuthoringSetupContext {
  return {
    sandbox,
    workspace,
    sourceRoot: "/tmp/eve-source",
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

function shellCommands(toolCalls: ReadonlyArray<{ input: unknown }>): string[] {
  return toolCalls.flatMap((call) => {
    if (typeof call.input !== "object" || call.input === null) return [];
    const command = (call.input as { command?: unknown }).command;
    return typeof command === "string" ? [command] : [];
  });
}

function bootstrapHash(authoringCase: AuthoringCase): string {
  const setupIds = [authoringCase.startingPoint.setup, authoringCase.setup]
    .filter((setup): setup is AuthoringSetup => setup !== undefined)
    .map((setup) => setup.id)
    .join("-");
  return `eve-authoring-${SUBJECT_REPOSITORY}-${SUBJECT_REVISION}-${authoringCase.startingPoint.id}-${setupIds}`;
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
  return sandbox.run({ command, ...(workingDirectory === undefined ? {} : { workingDirectory }) });
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

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`The authoring benchmark runner must provide ${name}.`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
