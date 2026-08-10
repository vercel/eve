import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";
import { createPi } from "@ai-sdk/harness-pi";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";

import type {
  AuthoringCase,
  BenchmarkGrade,
  BenchmarkRunArtifact,
  SubjectToolCall,
  SubjectToolResult,
  SubjectTurn,
} from "./types.js";

const WORKSPACE = "workspace";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SUBJECT_REVISION = "origin/main";
const BENCHMARK_BOOTSTRAP_VERSION = 2;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);

export interface RunBenchmarkOptions {
  readonly evaluation: AuthoringCase;
  readonly model?: string;
  readonly artifactRoot?: string;
  readonly timeoutMs?: number;
  /** Receives live lifecycle updates while sandbox and subject work is in flight. */
  readonly onProgress?: (message: string) => void;
  /** Receives normalized HarnessAgent diagnostics as they arrive. */
  readonly onDiagnostic?: (event: unknown) => void;
}

/** Runs one authoring case through AI SDK HarnessAgent and grades its sandbox. */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkRunArtifact> {
  const { evaluation } = options;
  const startedAt = new Date().toISOString();
  const progress = options.onProgress ?? (() => {});
  const repository = process.env.EVE_BENCHMARK_REPOSITORY ?? "https://github.com/vercel/eve.git";
  const requestedRevision = process.env.EVE_BENCHMARK_REVISION ?? DEFAULT_SUBJECT_REVISION;
  progress(`Resolving subject revision ${requestedRevision}`);
  const subjectRevision = await resolveSubjectRevision(repository, requestedRevision);
  progress(`Subject revision: ${subjectRevision.slice(0, 12)}`);
  const world = evaluation.createWorld();
  const user = evaluation.createUser();
  const transcript: SubjectTurn[] = [{ role: "user", text: evaluation.prompt }];
  const toolCalls: SubjectToolCall[] = [];
  const toolResults: SubjectToolResult[] = [];
  const usage: Record<string, unknown> = {};
  const diagnostics: unknown[] = [];
  let error: string | undefined;
  let grade: BenchmarkGrade = { passed: false, checks: [] };
  let sandbox: HarnessV1NetworkSandboxSession | undefined;
  let workspace: string | undefined;

  const sandboxProvider = createVercelSandbox({
    runtime: "node24",
    ports: [4317, 4173],
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: world.env,
    networkPolicy: "allow-all",
  });

  const agent = new HarnessAgent({
    id: "eve-authoring-benchmark",
    harness: createPi({
      ...(options.model === undefined ? {} : { model: options.model }),
      thinkingLevel: "medium",
    }),
    sandbox: sandboxProvider,
    sandboxConfig: {
      workDir: WORKSPACE,
      bootstrapHash: `eve-authoring-${evaluation.id}-${subjectRevision}-v${BENCHMARK_BOOTSTRAP_VERSION}`,
      async onBootstrap({ session, workDir }) {
        progress("Building reusable eve benchmark template");
        await world.bootstrap({ sandbox: session });
        await bootstrapSubject(session, workDir, repository, subjectRevision, progress);
      },
      async onSession({ session, sessionWorkDir }) {
        sandbox = session as HarnessV1NetworkSandboxSession;
        workspace = sessionWorkDir;
        progress("Installing simulated Photon and Vercel world");
        await world.install({ sandbox, workspace: sessionWorkDir });
        progress("Simulated world is ready");
        await seedCaseWorkspace(session, sessionWorkDir, progress);
      },
    },
    instructions: evaluation.instructions,
    permissionMode: "allow-all",
    debug: { enabled: true, level: "info" },
    onLog: (event) => {
      diagnostics.push(event);
      options.onDiagnostic?.(event);
    },
  });

  let session: Awaited<ReturnType<typeof agent.createSession>> | undefined;
  try {
    session = await withHeartbeat("Preparing sandbox and eve project", progress, () =>
      agent.createSession(),
    );
    if (sandbox === undefined || workspace === undefined) {
      throw new Error("HarnessAgent did not initialize its sandbox session.");
    }
    let prompt = evaluation.prompt;
    for (let turn = 0; ; turn += 1) {
      const result = await withHeartbeat(
        turn === 0 ? "Coding agent is working" : `Coding agent is continuing (user turn ${turn})`,
        progress,
        () =>
          agent.generate({
            session: session!,
            prompt,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          }),
      );
      transcript.push({ role: "assistant", text: result.text });
      toolCalls.push(
        ...result.toolCalls.map((call) => ({ name: String(call.toolName), input: call.input })),
      );
      toolResults.push(
        ...result.toolResults.map((candidate) => ({
          name: String(candidate.toolName),
          output: "output" in candidate ? candidate.output : candidate,
        })),
      );
      Object.assign(usage, result.usage);

      if (turn >= evaluation.maximumUserTurns || !looksLikeQuestion(result.text)) break;
      const response = await user.respond(result.text);
      if (response.kind === "fail") throw new Error(response.reason);
      transcript.push({ role: "user", text: response.text });
      prompt = response.text;
    }

    const worldEvents = await world.events();
    grade = await evaluation.grade({
      sandbox,
      workspace,
      transcript,
      toolCalls,
      toolResults,
      worldEvents,
      usage,
    });
  } catch (caught) {
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  }

  const worldEvents = await world.events().catch(() => []);
  const artifactPath = resolveArtifactPath(options.artifactRoot, startedAt, evaluation.id);
  const artifact: BenchmarkRunArtifact = {
    schemaVersion: 1,
    caseId: evaluation.id,
    harness: "pi",
    ...(options.model === undefined ? {} : { model: options.model }),
    subjectRevision,
    startedAt,
    completedAt: new Date().toISOString(),
    artifactPath,
    transcript,
    toolCalls,
    toolResults,
    diagnostics,
    worldEvents,
    usage,
    grade,
    ...(error === undefined ? {} : { error }),
  };

  await writeArtifact(artifact);
  await world.dispose();
  await session?.destroy();
  return artifact;
}

interface SetupStep {
  readonly label: string;
  readonly command: string;
  readonly workingDirectory?: string;
}

async function bootstrapSubject(
  sandbox: Experimental_SandboxSession,
  workspace: string,
  repository: string,
  revision: string,
  progress: (message: string) => void,
): Promise<void> {
  const environment = setupEnvironment();
  await runSetupSteps(
    sandbox,
    [
      {
        label: "clone eve",
        command: [
          `git clone --depth 1 ${shellQuote(repository)} /tmp/eve-source`,
          `git -C /tmp/eve-source fetch --depth 1 origin ${shellQuote(normalizeRevision(revision))}`,
          "git -C /tmp/eve-source checkout --detach FETCH_HEAD",
        ].join(" && "),
      },
      {
        label: "install eve dependencies",
        command: "corepack enable && pnpm install --frozen-lockfile",
        workingDirectory: "/tmp/eve-source",
      },
      {
        label: "build eve and its registry",
        command: "pnpm --filter eve build && pnpm --filter eve-docs registry:build",
        workingDirectory: "/tmp/eve-source",
      },
      { label: "create template workspace", command: `mkdir -p ${shellQuote(workspace)}` },
      {
        label: "initialize template eve project",
        command:
          "AI_AGENT=benchmark EVE_INIT_PACKAGE_SPEC=file:/tmp/eve-source/packages/eve node /tmp/eve-source/packages/eve/bin/eve.js init .",
        workingDirectory: workspace,
      },
      {
        label: "pin project package manager policy",
        command: [
          "pnpm config set --location=project minimum-release-age 0",
          "pnpm config set --location=project manage-package-manager-versions false",
        ].join(" && "),
        workingDirectory: workspace,
      },
      {
        label: "install template dependencies",
        command: "pnpm install --config.minimumReleaseAge=0",
        workingDirectory: workspace,
      },
    ],
    environment,
    progress,
  );
}

async function seedCaseWorkspace(
  sandbox: Experimental_SandboxSession,
  workspace: string,
  progress: (message: string) => void,
): Promise<void> {
  await runSetupSteps(
    sandbox,
    [
      {
        label: "start the local registry",
        command:
          "nohup python3 -m http.server 4173 --directory /tmp/eve-source/apps/docs/public >/tmp/eve-registry.log 2>&1 </dev/null &",
      },
      {
        label: "seed Vercel project link",
        command: `mkdir -p .vercel && printf '%s' '{"orgId":"team-id","projectId":"project-id","projectName":"benchmark-agent"}' > .vercel/project.json`,
        workingDirectory: workspace,
      },
    ],
    setupEnvironment(),
    progress,
  );
}

async function runSetupSteps(
  sandbox: Experimental_SandboxSession,
  steps: readonly SetupStep[],
  environment: Record<string, string>,
  progress: (message: string) => void,
): Promise<void> {
  for (const step of steps) {
    progress(`Setup: ${step.label}`);
    const startedAt = Date.now();
    const result = await sandbox.run({
      command: step.command,
      ...(step.workingDirectory === undefined ? {} : { workingDirectory: step.workingDirectory }),
      env: environment,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not seed benchmark project (${step.label}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    progress(`Setup complete: ${step.label} (${formatDuration(Date.now() - startedAt)})`);
  }
}

function setupEnvironment(): Record<string, string> {
  return {
    AI_AGENT: "benchmark",
    EVE_DEV_OFFICIAL_REGISTRY_URL: "http://127.0.0.1:4173/r",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
  };
}

async function withHeartbeat<T>(
  label: string,
  progress: (message: string) => void,
  task: () => PromiseLike<T>,
): Promise<T> {
  const startedAt = Date.now();
  progress(label);
  const timer = setInterval(() => {
    progress(`${label} (${formatDuration(Date.now() - startedAt)} elapsed)`);
  }, 15_000);
  timer.unref();
  try {
    return await task();
  } finally {
    clearInterval(timer);
    progress(`${label} finished (${formatDuration(Date.now() - startedAt)})`);
  }
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function resolveSubjectRevision(repository: string, revision: string): Promise<string> {
  if (/^[0-9a-f]{40}$/iu.test(revision)) return revision.toLowerCase();
  const normalized = normalizeRevision(revision);
  const { stdout } = await execFileAsync("git", [
    "ls-remote",
    repository,
    normalized,
    `refs/heads/${normalized}`,
    `refs/tags/${normalized}^{}`,
    `refs/tags/${normalized}`,
  ]);
  const sha = stdout.match(/^[0-9a-f]{40}/imu)?.[0];
  if (sha === undefined) {
    throw new Error(`Could not resolve benchmark subject revision ${JSON.stringify(revision)}.`);
  }
  return sha.toLowerCase();
}

function normalizeRevision(revision: string): string {
  return revision.startsWith("origin/") ? revision.slice("origin/".length) : revision;
}

function looksLikeQuestion(text: string): boolean {
  return text.includes("?") || /please provide|what(?:'s| is) your|which .* should/i.test(text);
}

function resolveArtifactPath(
  configuredRoot: string | undefined,
  startedAt: string,
  caseId: string,
): string {
  const root = resolve(configuredRoot ?? REPOSITORY_ROOT, ".eve/authoring-benchmarks");
  const timestamp = startedAt.replaceAll(/[:.]/g, "-");
  return resolve(root, `${timestamp}-${caseId}.json`);
}

async function writeArtifact(artifact: BenchmarkRunArtifact): Promise<void> {
  await mkdir(dirname(artifact.artifactPath), { recursive: true });
  await writeFile(artifact.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
