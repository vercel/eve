import assert from "node:assert/strict";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import type { SandboxSession } from "eve/sandbox";
import { defineSkill } from "eve/skills";
import { defineTool } from "eve/tools";

import { ContextContainer, contextStorage } from "../../../eve/dist/src/context/container.js";
import {
  HistoryStateKey,
  ParentSessionKey,
  SandboxKey,
  SessionIdKey,
  SessionKey,
} from "../../../eve/dist/src/context/keys.js";
import { fromCompiledBundle } from "../../../eve/dist/src/definitions/compiled-agent.js";
import { runEffects } from "../../../eve/dist/src/definitions/kernel.js";
import { evaluateValues, stepDraft, stepMessages } from "../../../eve/dist/src/definitions/step.js";
import { keptAnnouncements } from "../../../eve/dist/src/harness/announcements.js";
import {
  currentView,
  enterSessionProjection,
  recordPublishedLine,
} from "../../../eve/dist/src/harness/session-machine/current.js";
import { registerDefinitionSource } from "../../../eve/dist/src/internal/authored-definition/source-identity.js";
import { createModelMetadata } from "../../../eve/dist/src/internal/model-catalog.js";
import { SessionAgentKey } from "../../../eve/dist/src/runtime/sessions/runtime-context-keys.js";
import type { SandboxAccess } from "../../../eve/dist/src/sandbox/state.js";

(globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
  "eve-code-repositories-lifecycle-test";
const { default: extension } = await import("../../extension/extension.ts");
const { default: repositoriesHook } = await import("../../extension/hooks/repositories.ts");
const { default: projectInstructions } = await import("../../extension/instructions/project.ts");
const { default: repositorySkills } = await import("../../extension/skills/repository.ts");

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Eve Test",
  GIT_AUTHOR_EMAIL: "eve@example.com",
  GIT_COMMITTER_NAME: "Eve Test",
  GIT_COMMITTER_EMAIL: "eve@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const MODEL_METADATA = createModelMetadata({
  catalog: {
    models: [
      {
        slug: "openai/gpt-5.4",
        providers: [
          { contextWindowTokens: 400_000, provider: "openai", providerModelId: "gpt-5.4" },
        ],
      },
    ],
    providerAliases: {},
  },
  fetchedAt: "2026-01-01T00:00:00.000Z",
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function initUpstreamRepo(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
}

interface InstrumentedSandbox {
  readonly access: SandboxAccess;
  readonly commands: string[];
  readonly writtenFiles: Map<string, Uint8Array>;
  readonly getOpenCount: () => number;
}

function createRealSandboxAccess(
  workspaceDir: string,
  envOverrides: NodeJS.ProcessEnv = {},
): InstrumentedSandbox {
  const commands: string[] = [];
  const writtenFiles = new Map<string, Uint8Array>();
  let openCount = 0;
  let started = false;

  const session: SandboxSession = {
    resolvePath(path: string) {
      return isAbsolute(path) ? path : join(workspaceDir, path);
    },
    async run({ command, workingDirectory }) {
      commands.push(command);
      const cwd =
        workingDirectory === undefined
          ? workspaceDir
          : isAbsolute(workingDirectory)
            ? workingDirectory
            : join(workspaceDir, workingDirectory);
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
          cwd,
          env: { ...GIT_ENV, ...envOverrides },
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        };
      }
    },
    async spawn({ command, workingDirectory, env }) {
      commands.push(command);
      const cwd =
        workingDirectory === undefined
          ? workspaceDir
          : isAbsolute(workingDirectory)
            ? workingDirectory
            : join(workspaceDir, workingDirectory);
      const child = spawnProcess("bash", ["-c", command], {
        cwd,
        env: { ...GIT_ENV, ...envOverrides, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
        let settled = false;
        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode: code });
        };
        child.once("error", () => finish(1));
        child.once("close", (code) => finish(typeof code === "number" ? code : 1));
      });
      const stdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const stderr = Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>;
      return {
        ...(child.pid !== undefined && { pid: child.pid }),
        stdout,
        stderr,
        wait: () => exitPromise,
        async kill() {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              if (process.platform === "win32") child.kill();
              else child.kill("SIGKILL");
            } catch {}
          }
          child.stdout.destroy();
          child.stderr.destroy();
          await exitPromise;
        },
      };
    },
    async readFile() {
      return null;
    },
    async readBinaryFile() {
      return null;
    },
    async readTextFile() {
      return null;
    },
    async writeFile() {},
    async writeBinaryFile({ path, content }) {
      writtenFiles.set(path, new Uint8Array(content));
    },
    async writeTextFile({ path, content }) {
      writtenFiles.set(path, new Uint8Array(Buffer.from(content, "utf8")));
    },
    async writeFiles({ files }) {
      for (const file of files) {
        writtenFiles.set(file.path, new Uint8Array(file.content));
      }
    },
    async removePath() {},
  };

  let queue = Promise.resolve();

  const open = async () => {
    if (!started) {
      started = true;
      openCount += 1;
    }
    return session;
  };

  const access: SandboxAccess = {
    async captureState() {
      return { session: null };
    },
    async get() {
      await queue;
      return await open();
    },
    async getIfStarted() {
      await queue;
      return started ? await open() : null;
    },
    async open() {
      return await this.get();
    },
    prepare(work) {
      queue = queue.then(() => work?.(open)).catch(() => undefined);
    },
    async stop() {
      started = false;
    },
  };

  return {
    access,
    commands,
    writtenFiles,
    getOpenCount: () => openCount,
  };
}

function unwrapDynamic(sentinel: unknown): (ctx: unknown) => unknown {
  const symbol = Symbol.for("eve.dynamic");
  return (sentinel as Record<symbol, (ctx: unknown) => unknown>)[symbol]!;
}

interface SessionHarness {
  readonly ctx: ContextContainer;
  readonly conversation: { role: "user" | "assistant"; content: string; kind?: string }[];
  readonly startTurn: (turnId: string) => Promise<void>;
  readonly settleToolCall: (input: {
    readonly callId: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly output?: Record<string, unknown>;
  }) => Promise<void>;
  readonly nextModelCall: () => Promise<{
    readonly newUserInstructions: readonly string[];
    readonly skillNames: readonly string[];
  }>;
  readonly compactHistory: () => void;
}

function createSessionHarness(
  sandboxAccess: SandboxAccess,
  sessionId: string,
  options: { readonly parentSessionId?: string } = {},
): SessionHarness {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  const parent =
    options.parentSessionId !== undefined
      ? {
          callId: "call_delegate",
          rootSessionId: options.parentSessionId,
          sessionId: options.parentSessionId,
          turn: { id: "turn_1", number: 1 },
        }
      : undefined;
  if (parent !== undefined) {
    ctx.set(ParentSessionKey, parent as never);
  }
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    ...(parent !== undefined && { parent }),
    sessionId,
    turn: { id: "turn_0", number: 0 },
  } as never);
  ctx.set(SandboxKey, sandboxAccess);
  ctx.set(
    SessionAgentKey,
    fromCompiledBundle({
      graph: { nodesByNodeId: new Map() },
      modelMetadata: async () => MODEL_METADATA,
      nodeId: "root",
      resolvedAgent: {
        definitions: [
          {
            evaluate: unwrapDynamic(projectInstructions),
            extensionNamespace: "code",
            kind: "instructions",
            logicalPath: "instructions/code__project.ts",
            slug: "code__project",
            sourceId: "instructions/code__project.ts",
            sourceKind: "module",
          },
          {
            evaluate: unwrapDynamic(repositorySkills),
            extensionNamespace: "code",
            kind: "skill",
            logicalPath: "skills/code__repository.ts",
            slug: "code__repository",
            sourceId: "skills/code__repository.ts",
            sourceKind: "module",
          },
          {
            events: repositoriesHook.events,
            kind: "hook",
            logicalPath: "hooks/code__repositories.ts",
            slug: "code__repositories",
            sourceId: "hooks/code__repositories.ts",
            sourceKind: "module",
          },
        ],
        instructions: [],
        skills: [],
      },
      subagentRegistry: { dynamicResolvers: [], preparedTools: [] },
      turnAgent: {
        model: "openai/gpt-5.4",
        tools: new Map(),
      },
    } as never),
  );

  let line = 0;
  let currentTurnId = "turn_0";
  const conversation: { role: "user" | "assistant"; content: string; kind?: string }[] = [];

  enterSessionProjection(ctx, undefined);

  async function emit(events: readonly Record<string, unknown>[]): Promise<void> {
    const positionLine = line;
    line += 1;
    const at = new Date().toISOString();
    const facts = events.map((event, index) => ({
      ...event,
      meta: {
        at,
        id: `evt_${positionLine}_${index}`,
        position: { index, line: positionLine },
      },
    }));
    recordPublishedLine(ctx, { at, facts } as never, positionLine, facts as never);
    const view = currentView(ctx);
    const written = facts.map((event, index) => ({
      event,
      position: { index, line: positionLine },
      progress: false,
      view,
    }));
    await contextStorage.run(ctx, () =>
      runEffects(ctx, {
        conversation: conversation as never,
        written: written as never,
      }),
    );
  }

  return {
    ctx,
    conversation,

    async startTurn(turnId: string) {
      const follows = currentTurnId === "turn_0" ? null : currentTurnId;
      currentTurnId = turnId;
      ctx.set(SessionKey, {
        auth: { current: null, initiator: null },
        ...(parent !== undefined && { parent }),
        sessionId,
        turn: { id: turnId, number: line + 1 },
      } as never);
      await emit([
        {
          type: "turn.started",
          scope: { sessionId, turnId },
          data: {
            turnId,
            cause: { deliveryId: `del_${turnId}` },
            follows,
          },
        },
      ]);
    },

    async settleToolCall({ callId, name, input, output }) {
      await emit([
        {
          type: "call.requested",
          scope: { sessionId, turnId: currentTurnId },
          data: {
            callId,
            owner: { turnId: currentTurnId },
            capability: { kind: "tool", name },
            input,
          },
        },
        {
          type: "call.settled",
          scope: { sessionId, turnId: currentTurnId },
          data: {
            callId,
            outcome: "completed",
            output: output ?? { ok: true },
          },
        },
      ]);
    },

    async nextModelCall() {
      const beforeCount = conversation.length;
      return await contextStorage.run(ctx, async () => {
        await evaluateValues(ctx, { conversation: conversation as never });
        const stepSource = {
          config: { tools: new Map() },
          ctx,
          finalReplyOnly: false,
          session: { rootSessionId: sessionId },
        };
        const draft = await stepDraft(stepSource as never);
        const result = await stepMessages(draft, {
          call: {
            currentInput: new Set(),
            historyState: ctx.get(HistoryStateKey) ?? {},
            record: conversation as never,
          },
          project: (record) => [...record],
        });
        ctx.set(HistoryStateKey, result.historyState);
        const skills = await draft.tools();
        conversation.length = 0;
        for (const msg of result.record) {
          conversation.push(msg as (typeof conversation)[number]);
        }
        const added = conversation
          .slice(beforeCount)
          .filter((msg) => msg.role === "user" && msg.kind === "context.instruction")
          .map((msg) => msg.content);
        return {
          newUserInstructions: added,
          skillNames: [...skills.skills.keys()],
        };
      });
    },

    compactHistory() {
      conversation.length = 0;
      conversation.push({ role: "user", content: "Compacted summary of earlier work." });
      const currentHistory = ctx.get(HistoryStateKey) ?? {};
      ctx.set(HistoryStateKey, keptAnnouncements(currentHistory, conversation as never));
    },
  };
}

test("post-clone sparse repo A, repo B deduplication, scoped AGENTS.md caching, compaction re-injection, and subagent sandbox inheritance", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-full-")));
  try {
    const upstreamA = join(root, "upstream-a");
    const upstreamB = join(root, "upstream-b");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    await initUpstreamRepo(upstreamA, {
      "AGENTS.md": "Repo A root rules from HEAD.\n",
      "packages/sub/AGENTS.md": "Repo A subpackage rules.\n",
      "packages/sub/index.ts": "export const a = 1;\n",
      "packages/sub/other.ts": "export const b = 2;\n",
    });
    await initUpstreamRepo(upstreamB, {
      "AGENTS.md": "Repo B root rules.\n",
      "src/main.ts": "export const main = true;\n",
    });

    const binaryAsset = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x42]);
    const onEnterParents: (string | undefined)[] = [];
    extension({
      repositories: {
        rules: [
          {
            match: (repo) => repo.root.endsWith("/repoA"),
            onEnter(_repo, ctx) {
              onEnterParents.push(ctx.session.parent?.sessionId);
              return {
                instructions: "Custom onEnter note for Repo A.",
                skills: {
                  repo_a_helper: defineSkill({
                    description: "Repo A helper skill",
                    content: "Use Repo A build pipeline.",
                    files: {
                      "assets/data.bin": binaryAsset,
                    },
                  }),
                },
              };
            },
          },
        ],
      },
    });

    const sandbox = createRealSandboxAccess(workspace);
    const parent = createSessionHarness(sandbox.access, "session-parent");

    await parent.startTurn("turn_1");
    const step1 = await parent.nextModelCall();
    assert.deepEqual(step1.newUserInstructions, []);
    assert.deepEqual(step1.skillNames, []);
    assert.equal(
      sandbox.commands.length,
      1,
      "turn.started + model call 1 must run only a single discovery scan",
    );

    const cloneA = join(workspace, "repoA");
    await git(workspace, ["clone", "--no-checkout", `file://${upstreamA}`, cloneA]);
    await git(cloneA, ["sparse-checkout", "init", "--no-cone"]);
    await git(cloneA, ["sparse-checkout", "set", "packages/sub/"]);
    await git(cloneA, ["checkout"]);

    await parent.settleToolCall({
      callId: "call_clone_a",
      name: "bash",
      input: { command: `git clone --no-checkout file://${upstreamA} repoA` },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });

    const step2 = await parent.nextModelCall();
    await sandbox.access.getIfStarted();
    assert.equal(step2.newUserInstructions.length, 1);
    assert.match(step2.newUserInstructions[0] ?? "", /<repository_rules/u);
    assert.match(step2.newUserInstructions[0] ?? "", /Custom onEnter note for Repo A\./u);
    assert.match(step2.newUserInstructions[0] ?? "", /Repo A root rules from HEAD\./u);
    assert.match(step2.newUserInstructions[0] ?? "", /source="git"/u);
    assert.deepEqual(step2.skillNames, ["code__repo_a_helper"]);
    const writtenBin = [...sandbox.writtenFiles.entries()].find(([path]) =>
      path.endsWith("assets/data.bin"),
    );
    assert.ok(writtenBin !== undefined, "Uint8Array skill file is materialized in the sandbox");
    assert.deepEqual(writtenBin[1], binaryAsset);
    assert.deepEqual(onEnterParents, [undefined]);

    const cloneB = join(workspace, "repoB");
    await git(workspace, ["clone", `file://${upstreamB}`, cloneB]);
    await parent.settleToolCall({
      callId: "call_clone_b",
      name: "bash",
      input: { command: `git clone file://${upstreamB} repoB` },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });

    const step3 = await parent.nextModelCall();
    assert.equal(step3.newUserInstructions.length, 1, "only Repo B is newly announced");
    assert.match(step3.newUserInstructions[0] ?? "", /Repo B root rules\./u);
    assert.doesNotMatch(step3.newUserInstructions[0] ?? "", /Repo A root rules/u);

    await parent.settleToolCall({
      callId: "call_read_sub_1",
      name: "read_file",
      input: { filePath: "repoA/packages/sub/index.ts" },
      output: {
        path: join(workspace, "repoA", "packages", "sub", "index.ts").replaceAll("\\", "/"),
      },
    });

    const step4 = await parent.nextModelCall();
    assert.equal(step4.newUserInstructions.length, 1);
    assert.match(step4.newUserInstructions[0] ?? "", /<scoped_instructions/u);
    assert.match(step4.newUserInstructions[0] ?? "", /Repo A subpackage rules\./u);
    assert.doesNotMatch(step4.newUserInstructions[0] ?? "", /Repo A root rules/u);

    const commandsBeforeSecondRead = sandbox.commands.length;
    await parent.settleToolCall({
      callId: "call_read_sub_2",
      name: "read_file",
      input: { filePath: "repoA/packages/sub/other.ts" },
      output: {
        path: join(workspace, "repoA", "packages", "sub", "other.ts").replaceAll("\\", "/"),
      },
    });
    const step5 = await parent.nextModelCall();
    assert.equal(
      sandbox.commands.length,
      commandsBeforeSecondRead,
      "second read in cached directory makes 0 extra sandbox calls",
    );
    assert.deepEqual(step5.newUserInstructions, []);

    parent.compactHistory();
    const afterCompaction = await parent.nextModelCall();
    const combinedAfterCompaction = afterCompaction.newUserInstructions.join("\n");
    assert.match(combinedAfterCompaction, /Repo A root rules from HEAD\./u);
    assert.match(combinedAfterCompaction, /Repo B root rules\./u);
    assert.match(combinedAfterCompaction, /Repo A subpackage rules\./u);

    const subagent = createSessionHarness(sandbox.access, "session-subagent", {
      parentSessionId: "session-parent",
    });
    await subagent.startTurn("sub_turn_1");
    const subStep1 = await subagent.nextModelCall();
    const subCombined = subStep1.newUserInstructions.join("\n");
    assert.match(subCombined, /Repo A root rules from HEAD\./u);
    assert.match(subCombined, /Repo B root rules\./u);
    assert.deepEqual(onEnterParents, [undefined, "session-parent"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("deterministic pre-seeded repository runs onEnter and injects AGENTS.md before model call 1 without duplicate scans", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-preseeded-")));
  try {
    const workspace = join(root, "workspace");
    await initUpstreamRepo(workspace, {
      "AGENTS.md": "Pre-seeded workspace rules.\n",
      "CONTRIBUTING.md": "Contribution guidelines.\n",
    });

    let enteredCount = 0;
    extension({
      repositories: {
        rules: [
          {
            files: ["CONTRIBUTING.md"],
            async onEnter(repo) {
              enteredCount += 1;
              const extra = await repo.readFile("CONTRIBUTING.md");
              return {
                instructions: `Loaded ${extra?.relativePath ?? "none"} on enter.`,
              };
            },
          },
        ],
      },
    });

    const sandbox = createRealSandboxAccess(workspace);
    const session = createSessionHarness(sandbox.access, "session-preseeded");

    await session.startTurn("turn_1");
    assert.equal(enteredCount, 1);
    const commandsAfterTurnStart = sandbox.commands.length;

    const call1 = await session.nextModelCall();
    assert.equal(
      sandbox.commands.length,
      commandsAfterTurnStart,
      "model call 1 must not re-scan after turn.started already synced",
    );
    assert.equal(call1.newUserInstructions.length, 1);
    assert.match(call1.newUserInstructions[0] ?? "", /Pre-seeded workspace rules\./u);
    assert.match(call1.newUserInstructions[0] ?? "", /Contribution guidelines\./u);
    assert.match(call1.newUserInstructions[0] ?? "", /Loaded CONTRIBUTING\.md on enter\./u);

    await session.startTurn("turn_2");
    assert.equal(enteredCount, 1, "onEnter runs only once per session per repository");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("discoverOnStart on-sandbox-use stays idle on non-coding turns and syncs once sandbox opens mid-turn", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-lazy-")));
  try {
    const workspace = join(root, "workspace");
    await initUpstreamRepo(workspace, { "AGENTS.md": "Lazy workspace rules.\n" });

    extension({
      repositories: {
        discoverOnStart: "on-sandbox-use",
      },
    });

    const sandbox = createRealSandboxAccess(workspace);
    const session = createSessionHarness(sandbox.access, "session-lazy");

    await session.startTurn("turn_1");
    const call1 = await session.nextModelCall();
    assert.equal(sandbox.getOpenCount(), 0, "sandbox must not start on a non-coding turn");
    assert.equal(sandbox.commands.length, 0);
    assert.deepEqual(call1.newUserInstructions, []);

    await session.settleToolCall({
      callId: "call_external_fetch",
      name: "crm__run",
      input: { command: "fetch" },
      output: { ok: true },
    });
    assert.equal(
      sandbox.getOpenCount(),
      0,
      "non-sandbox tool with command input must not open the sandbox",
    );
    assert.equal(sandbox.commands.length, 0);

    await sandbox.access.open();
    await session.settleToolCall({
      callId: "call_bash_midturn",
      name: "bash",
      input: { command: "ls -la" },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });

    const call2 = await session.nextModelCall();
    assert.equal(call2.newUserInstructions.length, 1);
    assert.match(call2.newUserInstructions[0] ?? "", /Lazy workspace rules\./u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("HEAD change prunes deleted scopes, repo delete + re-clone re-runs onEnter, and grep on direct subdir loads scoped AGENTS.md", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-mutations-")));
  try {
    const upstream = join(root, "upstream");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await initUpstreamRepo(upstream, {
      "AGENTS.md": "Root v1.\n",
      "MAIN_ONLY.md": "Main branch checklist.\n",
      "sub/AGENTS.md": "Sub v1.\n",
      "sub/file.ts": "export const v = 1;\n",
    });

    const cloneDir = join(workspace, "app");
    await git(workspace, ["clone", `file://${upstream}`, cloneDir]);

    let enterCount = 0;
    extension({
      repositories: {
        rules: [
          {
            match: (repo) => repo.branch === "main",
            files: ["MAIN_ONLY.md"],
          },
          {
            onEnter() {
              enterCount += 1;
              return { instructions: `Enter #${enterCount}` };
            },
          },
        ],
      },
    });

    const sandbox = createRealSandboxAccess(workspace);
    const session = createSessionHarness(sandbox.access, "session-mutations");

    await session.startTurn("turn_1");
    const call1 = await session.nextModelCall();
    assert.equal(enterCount, 1);
    assert.match(call1.newUserInstructions[0] ?? "", /Root v1\./u);
    assert.match(call1.newUserInstructions[0] ?? "", /Main branch checklist\./u);

    await session.settleToolCall({
      callId: "call_grep_sub",
      name: "grep",
      input: { path: "app/sub", pattern: "export" },
      output: { path: join(workspace, "app", "sub").replaceAll("\\", "/") },
    });
    const call2 = await session.nextModelCall();
    assert.equal(call2.newUserInstructions.length, 1);
    assert.match(call2.newUserInstructions[0] ?? "", /Sub v1\./u);

    await git(cloneDir, ["checkout", "-b", "feature/x"]);
    await rm(join(cloneDir, "sub", "AGENTS.md"));
    await writeFile(join(cloneDir, "AGENTS.md"), "Root v2.\n");
    await git(cloneDir, ["add", "-A"]);
    await git(cloneDir, ["commit", "-m", "drop sub agents"]);

    await session.settleToolCall({
      callId: "call_commit_v2",
      name: "bash",
      input: { command: "git -C app checkout feature/x" },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });
    const call3 = await session.nextModelCall();
    assert.equal(enterCount, 1, "HEAD change refreshes files without re-running onEnter");
    assert.match(call3.newUserInstructions[0] ?? "", /Root v2\./u);
    assert.doesNotMatch(
      call3.newUserInstructions[0] ?? "",
      /Main branch checklist\./u,
      "stale ruleFiles are cleared when a rule stops matching",
    );

    session.compactHistory();
    const afterHeadChangeCompaction = await session.nextModelCall();
    const afterHeadText = afterHeadChangeCompaction.newUserInstructions.join("\n");
    assert.match(afterHeadText, /Root v2\./u);
    assert.doesNotMatch(
      afterHeadText,
      /Sub v1\./u,
      "deleted scoped AGENTS.md was pruned on HEAD change",
    );

    await rm(cloneDir, { force: true, recursive: true });
    await session.settleToolCall({
      callId: "call_rm_repo",
      name: "bash",
      input: { command: "git status || true" },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });

    await git(workspace, ["clone", `file://${upstream}`, cloneDir]);
    await session.settleToolCall({
      callId: "call_reclone_repo",
      name: "bash",
      input: { command: `git clone file://${upstream} app` },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });
    const callReclone = await session.nextModelCall();
    assert.equal(enterCount, 2, "re-cloning after deletion re-runs onEnter");
    assert.match(callReclone.newUserInstructions[0] ?? "", /Enter #2/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("background bash clone keeps pending reconcile across polls until exit, syncAfter triggers reconciliation, and throwing match / onEnter / malformed skills are isolated", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-edge-")));
  try {
    const upstreamA = join(root, "upstream-a");
    const upstreamB = join(root, "upstream-b");
    const workspace = join(root, "workspace");
    const bgOutputDir = join(root, "bg-job-dir");
    await mkdir(workspace, { recursive: true });
    await mkdir(bgOutputDir, { recursive: true });
    await initUpstreamRepo(upstreamA, { "AGENTS.md": "Background clone A rules.\n" });
    await initUpstreamRepo(upstreamB, { "AGENTS.md": "SyncAfter B rules.\n" });

    const syncTool = defineTool({
      description: "Custom workspace sync",
      inputSchema: {},
      execute: () => ({ ok: true }),
    });
    registerDefinitionSource(syncTool, { kind: "tool", name: "custom_sync" });

    let enterCalls = 0;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      extension({
        repositories: {
          syncAfter: [syncTool],
          rules: [
            {
              match() {
                throw new Error("boom in match predicate");
              },
              onEnter() {
                return { instructions: "Should never run" };
              },
            },
            {
              onEnter() {
                enterCalls += 1;
                throw new Error("boom in first rule");
              },
            },
            {
              onEnter(repo) {
                return {
                  instructions: `Second rule ok for ${repo.root.split("/").at(-1)}.`,
                  skills: {
                    "bad name!": defineSkill({
                      description: "Invalid skill name",
                      content: "Should be skipped",
                    }),
                    eve__reserved: defineSkill({
                      description: "Reserved prefix",
                      content: "Should be skipped",
                    }),
                    malformed_missing_content: {
                      description: "Missing content field",
                    } as never,
                    malformed_bad_files: {
                      description: "Bad files payload",
                      content: "Valid body",
                      files: {
                        "broken.bin": 12345,
                      },
                    } as never,
                    shared_skill: defineSkill({
                      description: `Skill from ${repo.root.split("/").at(-1)}`,
                      content: `Content from ${repo.root.split("/").at(-1)}`,
                    }),
                  },
                };
              },
            },
          ],
        },
      });

      const sandbox = createRealSandboxAccess(workspace);
      const session = createSessionHarness(sandbox.access, "session-edge");

      await session.startTurn("turn_1");
      await session.nextModelCall();

      await session.settleToolCall({
        callId: "call_bg_clone",
        name: "bash",
        input: { command: `git clone file://${upstreamA} bgA` },
        output: {
          status: "running",
          outputDirectory: bgOutputDir.replaceAll("\\", "/"),
          message: "still running",
          stdout: "",
          stderr: "",
          truncated: false,
        },
      });
      assert.equal(enterCalls, 0, "background bash clone must not onboard prematurely");

      await session.settleToolCall({
        callId: "call_poll_still_running",
        name: "bash",
        input: { command: "echo polling" },
        output: { exitCode: 0, status: "completed", stdout: "polling\n", stderr: "" },
      });
      const whileRunning = await session.nextModelCall();
      assert.equal(enterCalls, 0);
      assert.deepEqual(whileRunning.newUserInstructions, []);

      await git(workspace, ["clone", `file://${upstreamA}`, join(workspace, "bgA")]);
      await writeFile(join(bgOutputDir, "exit"), "0\n");

      await session.settleToolCall({
        callId: "call_poll_done",
        name: "bash",
        input: { command: "echo done" },
        output: { exitCode: 0, status: "completed", stdout: "done\n", stderr: "" },
      });

      const afterBg = await session.nextModelCall();
      assert.equal(enterCalls, 1);
      assert.equal(afterBg.newUserInstructions.length, 1);
      assert.match(afterBg.newUserInstructions[0] ?? "", /Background clone A rules\./u);
      assert.match(afterBg.newUserInstructions[0] ?? "", /Second rule ok for bgA\./u);
      assert.deepEqual(afterBg.skillNames, ["code__shared_skill"]);
      assert.ok(warnings.some((w) => w.includes("boom in match predicate")));
      assert.ok(warnings.some((w) => w.includes("boom in first rule")));
      assert.ok(warnings.some((w) => w.includes("bad name!")));
      assert.ok(warnings.some((w) => w.includes("eve__reserved")));
      assert.ok(warnings.some((w) => w.includes("malformed_missing_content")));
      assert.ok(warnings.some((w) => w.includes("malformed_bad_files")));

      const commandsAfterBgCleared = sandbox.commands.length;
      await session.settleToolCall({
        callId: "call_idle_after_bg",
        name: "bash",
        input: { command: "echo idle" },
        output: { exitCode: 0, status: "completed", stdout: "idle\n", stderr: "" },
      });
      assert.equal(
        sandbox.commands.length,
        commandsAfterBgCleared,
        "pendingReconcile must be cleared once the background job finishes",
      );

      await git(workspace, ["clone", `file://${upstreamB}`, join(workspace, "syncB")]);
      await session.settleToolCall({
        callId: "call_custom_sync",
        name: "custom_sync",
        input: {},
        output: { ok: true },
      });

      const afterSync = await session.nextModelCall();
      assert.equal(afterSync.newUserInstructions.length, 1);
      assert.match(afterSync.newUserInstructions[0] ?? "", /SyncAfter B rules\./u);
      assert.match(afterSync.newUserInstructions[0] ?? "", /Second rule ok for syncB\./u);
      assert.deepEqual(afterSync.skillNames, ["code__shared_skill"]);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("propagates rule-file overflow paths into the overflow instruction when exceeding maxTotalBytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-rule-overflow-")));
  try {
    const workspace = join(root, "workspace");
    await initUpstreamRepo(workspace, {
      "BIG_RULE.md": `${"r".repeat(600)}\n`,
    });

    extension({
      repositories: {
        instructions: [],
        maxTotalBytes: 200,
        rules: [
          {
            files: ["BIG_RULE.md"],
          },
        ],
      },
    });

    const sandbox = createRealSandboxAccess(workspace);
    const session = createSessionHarness(sandbox.access, "session-rule-overflow");

    await session.startTurn("turn_1");
    const call1 = await session.nextModelCall();
    assert.equal(call1.newUserInstructions.length, 1);
    assert.match(
      call1.newUserInstructions[0] ?? "",
      /exceeded the automatic instruction byte budget/u,
    );
    assert.match(call1.newUserInstructions[0] ?? "", /BIG_RULE\.md/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
