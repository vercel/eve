import { readFileSync } from "node:fs";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { Agent, AgentRunResult } from "@vercel/agent-eval";

const WORKSPACE = "workspace";
const SUBJECT_REVISION = requiredEnvironmentVariable("EVE_BENCHMARK_REVISION");
const SUBJECT_REPOSITORY = requiredEnvironmentVariable("EVE_BENCHMARK_REPOSITORY");
const INSTRUCTIONS =
  "Work autonomously in the existing eve project. Use the installed, version-matched eve documentation and registry commands. Prefer non-interactive CLI commands intended for coding agents. Ask the user only for information that genuinely belongs to them.";

export interface UserSimulatorContext {
  readonly turn: number;
  readonly text: string;
  readonly transcript: ReadonlyArray<TranscriptEntry>;
}

export type UserSimulator = (
  context: UserSimulatorContext,
) => string | undefined | Promise<string | undefined>;

export interface AuthoringScenarioContext {
  readonly sandbox: HarnessV1NetworkSandboxSession;
  readonly workspace: string;
  readonly sourceRoot: string;
  run(command: string, workingDirectory?: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
}

export interface AuthoringScenario {
  /** Change this when bootstrap behavior or fixture dependencies change. */
  readonly id: string;
  /** Start from `eve init` output or an empty directory with the subject CLI installed. */
  readonly workspace?: "scaffolded" | "empty";
  readonly ports?: ReadonlyArray<number>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxTurns?: number;
  readonly instructions?: string;
  readonly onBootstrap?: (context: AuthoringScenarioContext) => Promise<void>;
  readonly onSession?: (context: AuthoringScenarioContext) => Promise<void>;
  readonly userSimulator?: UserSimulator;
}

interface TranscriptEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export function createAuthoringAgent(
  resolveScenario: (fixturePath: string) => AuthoringScenario,
): Agent {
  return {
    name: "eve-harness-pi",
    displayName: "eve HarnessAgent (Pi)",
    getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
    getDefaultModel: () => "claude-sonnet-4-6",
    definition: {
      name: "eve-harness-pi",
      displayName: "eve HarnessAgent (Pi)",
      defaultModel: "claude-sonnet-4-6",
      o11yAgentName: "claude-code",
      runnerPath: "",
      getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
      install: () => [],
      configFiles: () => [],
      authEnv: () => ({}),
    },
    async run(fixturePath, options): Promise<AgentRunResult> {
      const scenario = resolveScenario(fixturePath);
      const sandbox = createVercelSandbox({
        runtime: "node24",
        ports: [...(scenario.ports ?? [])],
        timeout: 15 * 60_000,
        env: { ...scenario.environment },
        networkPolicy: "allow-all",
      });
      const startedAt = Date.now();
      const commands: string[] = [];
      const transcript: TranscriptEntry[] = [{ role: "user", content: options.prompt }];
      let session: HarnessAgentSession | undefined;
      let activeSandbox: HarnessV1NetworkSandboxSession | undefined;
      let workspace: string | undefined;

      const agent = new HarnessAgent({
        id: "eve-authoring-eval",
        harness: createClaudeCode({
          auth: { gateway: { apiKey: options.apiKey } },
          ...(options.model === undefined ? {} : { model: options.model }),
          thinking: { type: "adaptive", display: "summarized" },
        }),
        sandbox,
        sandboxConfig: {
          workDir: WORKSPACE,
          bootstrapHash: bootstrapHash(scenario),
          onBootstrap: async ({ session: bootstrap, workDir }) => {
            const networkSandbox = bootstrap as HarnessV1NetworkSandboxSession;
            await bootstrapSubject(networkSandbox, workDir, scenario.workspace ?? "scaffolded");
            await scenario.onBootstrap?.(scenarioContext(networkSandbox, workDir));
          },
          onSession: async ({ session: current, sessionWorkDir }) => {
            activeSandbox = current as HarnessV1NetworkSandboxSession;
            workspace = sessionWorkDir;
            const context = scenarioContext(activeSandbox, workspace);
            await scenario.onSession?.(context);
            if (options.agentOptions?.agentsMd !== true) {
              await context.run("rm -f AGENTS.md CLAUDE.md");
            }
            await context.write(
              "__agent_eval__/results.json",
              JSON.stringify({ o11y: { shellCommands: [] } }),
            );
          },
        },
        instructions: scenario.instructions ?? INSTRUCTIONS,
        permissionMode: "allow-all",
      });

      try {
        session = await agent.createSession({ abortSignal: options.signal });
        if (activeSandbox === undefined || workspace === undefined) {
          throw new Error("HarnessAgent did not initialize its sandbox session.");
        }

        let prompt = options.prompt;
        const maxTurns = scenario.maxTurns ?? 1;
        for (let turn = 1; turn <= maxTurns; turn += 1) {
          const result = await agent.generate({
            session,
            prompt,
            timeout: options.timeout,
            abortSignal: options.signal,
          });
          transcript.push({ role: "assistant", content: result.text });
          commands.push(...shellCommands(result.toolCalls));

          const response = await scenario.userSimulator?.({ turn, text: result.text, transcript });
          if (response === undefined) break;
          if (turn === maxTurns) throw new Error(`User simulator exceeded maxTurns (${maxTurns}).`);
          prompt = response;
          transcript.push({ role: "user", content: prompt });
        }

        const context = scenarioContext(activeSandbox, workspace);
        await context.write(
          "__agent_eval__/results.json",
          JSON.stringify({
            o11y: { shellCommands: commands.map((command) => ({ command, success: true })) },
          }),
        );
        await context.write("__agent_eval__/harness-transcript.json", JSON.stringify(transcript));
        await context.write("EVAL.test.ts", readFileSync(`${fixturePath}/EVAL.ts`, "utf8"));

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
          await scenarioContext(activeSandbox, workspace)
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
    "npm install --global --package-lock=false $(find /tmp/eve-package -name '*.tgz' -print -quit) vitest@4.1.10",
    `cd ${shellQuote(workspace)}`,
  ];
  if (workspaceKind === "scaffolded") {
    commands.push(
      "AI_AGENT=benchmark EVE_INIT_PACKAGE_SPEC=$(find /tmp/eve-package -name '*.tgz' -print -quit) eve init .",
      "npm install --save-dev --package-lock=false vitest@4.1.10",
    );
  }
  await run(sandbox, commands.join(" && "));
}

function scenarioContext(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
): AuthoringScenarioContext {
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

function bootstrapHash(scenario: AuthoringScenario): string {
  return `eve-authoring-${SUBJECT_REPOSITORY}-${SUBJECT_REVISION}-${scenario.id}`;
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
