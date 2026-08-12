import { readFileSync } from "node:fs";

import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { Agent, AgentRunResult } from "@vercel/agent-eval";

const WORKSPACE = "workspace";
const PHONE_NUMBER = "+15551234567";
const REGISTRY_URL = "http://127.0.0.1:4173";
const SUBJECT_REVISION = requiredEnvironmentVariable("EVE_BENCHMARK_REVISION");
const SUBJECT_REPOSITORY = requiredEnvironmentVariable("EVE_BENCHMARK_REPOSITORY");

interface UserSimulatorContext {
  turn: number;
  text: string;
  transcript: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

type UserSimulator = (
  context: UserSimulatorContext,
) => string | undefined | Promise<string | undefined>;

const sandbox = createVercelSandbox({
  runtime: "node24",
  ports: [4173],
  timeout: 15 * 60_000,
  env: { EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL },
  networkPolicy: "allow-all",
});

export const harnessAgent: Agent = {
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
    const startedAt = Date.now();
    const commands: string[] = [];
    const transcript: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: options.prompt },
    ];
    let session: HarnessAgentSession | undefined;
    let harnessSandbox: HarnessV1NetworkSandboxSession | undefined;
    let workspace: string | undefined;

    const agent = new HarnessAgent({
      id: "eve-authoring-eval",
      harness: createClaudeCode({
        auth: {
          gateway: { apiKey: options.apiKey },
        },
        ...(options.model === undefined ? {} : { model: options.model }),
        thinking: { type: "adaptive", display: "summarized" },
      }),
      sandbox,
      sandboxConfig: {
        workDir: WORKSPACE,
        bootstrapHash: `eve-authoring-${SUBJECT_REPOSITORY}-${SUBJECT_REVISION}-v4`,
        onBootstrap: async ({ session: bootstrap, workDir }) => {
          await bootstrapSubject(bootstrap as HarnessV1NetworkSandboxSession, workDir);
        },
        onSession: async ({ session: active, sessionWorkDir }) => {
          harnessSandbox = active as HarnessV1NetworkSandboxSession;
          workspace = sessionWorkDir;
          await run(
            active as HarnessV1NetworkSandboxSession,
            "nohup python3 -m http.server 4173 --directory __authoring_eval__/registry >__authoring_eval__/registry.log 2>&1 </dev/null &",
            sessionWorkDir,
          );
          await write(
            active as HarnessV1NetworkSandboxSession,
            `${sessionWorkDir}/.claude/settings.json`,
            JSON.stringify({
              env: { EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL },
            }),
          );
          if (options.agentOptions?.agentsMd !== true) {
            await run(
              active as HarnessV1NetworkSandboxSession,
              "rm -f AGENTS.md CLAUDE.md",
              sessionWorkDir,
            );
          }
          await write(
            active as HarnessV1NetworkSandboxSession,
            `${sessionWorkDir}/__agent_eval__/results.json`,
            JSON.stringify({ o11y: { shellCommands: [] } }),
          );
        },
      },
      instructions:
        "Work autonomously in the existing eve project. Use the installed, version-matched eve documentation and registry commands. Prefer non-interactive CLI commands intended for coding agents. Ask the user only for information that genuinely belongs to them.",
      permissionMode: "allow-all",
    });

    try {
      session = await agent.createSession({ abortSignal: options.signal });
      if (harnessSandbox === undefined || workspace === undefined) {
        throw new Error("HarnessAgent did not initialize its sandbox session.");
      }

      const userSimulator = options.agentOptions?.userSimulator as UserSimulator | undefined;
      const maxTurns = (options.agentOptions?.maxTurns as number | undefined) ?? 1;
      let prompt = options.prompt;
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        const result = await agent.generate({
          session,
          prompt,
          timeout: options.timeout,
          abortSignal: options.signal,
        });
        transcript.push({ role: "assistant", content: result.text });
        commands.push(
          ...result.toolCalls.flatMap((call) => {
            if (typeof call.input !== "object" || call.input === null) return [];
            const command = (call.input as { command?: unknown }).command;
            return typeof command === "string" ? [command] : [];
          }),
        );

        const response = await userSimulator?.({ turn, text: result.text, transcript });
        if (response === undefined) break;
        if (turn === maxTurns) throw new Error(`User simulator exceeded maxTurns (${maxTurns}).`);
        prompt = response;
        transcript.push({ role: "user", content: prompt });
      }

      await write(
        harnessSandbox,
        `${workspace}/__agent_eval__/results.json`,
        JSON.stringify({
          o11y: { shellCommands: commands.map((command) => ({ command, success: true })) },
        }),
      );
      await write(
        harnessSandbox,
        `${workspace}/__agent_eval__/harness-transcript.json`,
        JSON.stringify(transcript),
      );
      await write(
        harnessSandbox,
        `${workspace}/EVAL.test.ts`,
        readFileSync(`${fixturePath}/EVAL.ts`, "utf8"),
      );
      const activeSandbox = harnessSandbox;
      const test = await resultOf(activeSandbox, "npx vitest run EVAL.test.ts", workspace);
      const scriptsResults = Object.fromEntries(
        await Promise.all(
          (options.scripts ?? []).map(async (script) => {
            const result = await resultOf(
              activeSandbox,
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
        error: test.exitCode === 0 && scriptsPassed ? undefined : `${test.stdout}\n${test.stderr}`,
        duration: Date.now() - startedAt,
        testResult: { success: test.exitCode === 0, output: `${test.stdout}${test.stderr}` },
        scriptsResults,
        sandboxId: harnessSandbox.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (harnessSandbox !== undefined && workspace !== undefined) {
        await write(
          harnessSandbox,
          `${workspace}/__agent_eval__/harness-transcript.json`,
          JSON.stringify(transcript),
        ).catch(() => undefined);
      }
      return {
        success: false,
        output: transcript.at(-1)?.content ?? "",
        error: message,
        duration: Date.now() - startedAt,
        scriptsResults: {},
        ...(harnessSandbox === undefined ? {} : { sandboxId: harnessSandbox.id }),
      };
    } finally {
      await session?.destroy();
    }
  },
};

async function bootstrapSubject(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
): Promise<void> {
  await run(
    sandbox,
    [
      "git clone --filter=blob:none --no-checkout " +
        shellQuote(SUBJECT_REPOSITORY) +
        " /tmp/eve-source",
      `git -C /tmp/eve-source fetch --depth 1 origin ${shellQuote(SUBJECT_REVISION)}`,
      "git -C /tmp/eve-source checkout --detach FETCH_HEAD",
      "corepack enable",
      "cd /tmp/eve-source",
      "pnpm install --frozen-lockfile",
      "pnpm --filter eve build",
      "mkdir -p /tmp/eve-package",
      "pnpm --dir packages/eve pack --pack-destination /tmp/eve-package",
      `cd ${shellQuote(workspace)}`,
      "AI_AGENT=benchmark EVE_INIT_PACKAGE_SPEC=$(find /tmp/eve-package -name '*.tgz' -print -quit) node /tmp/eve-source/packages/eve/bin/eve.js init .",
      `cd ${shellQuote(workspace)} && npm install --save-dev --package-lock=false vitest@4.1.10`,
      `cd ${shellQuote(workspace)} && npm install --save --package-lock=false /tmp/eve-source/apps/authoring-benchmarks/evals/author-000-imessage/seed/mock-imessage-setup`,
      `mkdir -p ${shellQuote(workspace)}/__authoring_eval__/registry/channel`,
      `cp /tmp/eve-source/apps/authoring-benchmarks/evals/author-000-imessage/seed/mock-imessage-setup/cli.mjs ${shellQuote(workspace)}/__authoring_eval__/seed-placeholder 2>/dev/null || true`,
    ].join(" && "),
  );
  await writeSyntheticWorld(sandbox, workspace);
}

async function writeSyntheticWorld(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
): Promise<void> {
  const channel = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: "channel/photon-imessage",
    title: "Photon iMessage",
    description: "Connect an eve agent to iMessage through a deterministic provider setup flow.",
    files: [
      {
        path: "registry/channels/photon-imessage.ts",
        type: "registry:file",
        target: "agent/channels/imessage.ts",
        content:
          'import { photonIMessageChannel } from "eve/channels/photon";\n\nexport default photonIMessageChannel({ credentials: async () => ({ projectId: "mock-imessage-project", projectSecret: "mock-imessage-secret" }) });\n',
      },
    ],
    meta: {
      eve: {
        setup: {
          command: "mock-imessage-setup",
          package: "@eve-internal/mock-imessage-setup",
          bin: "mock-imessage-setup",
          args: [],
        },
      },
    },
    type: "registry:item",
  };
  const registry = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "eve-authoring-eval",
    homepage: REGISTRY_URL,
    items: [
      {
        name: channel.name,
        type: "registry:item",
        description: channel.description,
        registry: `${REGISTRY_URL}/registry.json`,
        addCommandArgument: `${REGISTRY_URL}/channel/photon-imessage.json`,
      },
    ],
  };
  await write(
    sandbox,
    `${workspace}/__authoring_eval__/registry/registry.json`,
    JSON.stringify(registry),
  );
  await write(
    sandbox,
    `${workspace}/__authoring_eval__/registry/channel/photon-imessage.json`,
    JSON.stringify(channel),
  );
}

export const imessageUserSimulator: UserSimulator = ({ turn, text }) => {
  if (turn !== 1) return undefined;
  if (!/phone number|imessage number|number should/i.test(text)) {
    throw new Error(
      `Expected the agent to ask for the user's phone number on its first turn. Received: ${JSON.stringify(text)}`,
    );
  }
  return PHONE_NUMBER;
};

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
) {
  const result = await resultOf(sandbox, command, workingDirectory);
  if (result.exitCode !== 0)
    throw new Error(`${command} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function write(
  sandbox: HarnessV1NetworkSandboxSession,
  path: string,
  content: string,
): Promise<void> {
  await sandbox.writeTextFile({ path, content });
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`The authoring benchmark runner must provide ${name}.`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
