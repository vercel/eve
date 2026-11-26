import assert from "node:assert/strict";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import type { SandboxSession } from "eve/sandbox";
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

async function initUpstreamRepo(dir: string, files: Readonly<Record<string, string>>) {
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

function createRealSandboxAccess(workspaceDir: string) {
  const commands: string[] = [];
  let openCount = 0;
  let started = false;

  const session: SandboxSession = {
    resolvePath: (path) => (isAbsolute(path) ? path : join(workspaceDir, path)),
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
          env: GIT_ENV,
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
        env: { ...GIT_ENV, ...env },
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
      return {
        ...(child.pid !== undefined && { pid: child.pid }),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exitPromise,
        async kill() {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
          child.stdout.destroy();
          child.stderr.destroy();
          await exitPromise;
        },
      };
    },
    readFile: async () => null,
    readBinaryFile: async () => null,
    readTextFile: async () => null,
    writeFile: async () => undefined,
    writeBinaryFile: async () => undefined,
    writeTextFile: async () => undefined,
    writeFiles: async () => undefined,
    removePath: async () => undefined,
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
    captureState: async () => ({ session: null }),
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

  return { access, commands, getOpenCount: () => openCount };
}

function unwrapDynamic(sentinel: unknown): (ctx: unknown) => unknown {
  return (sentinel as Record<symbol, (ctx: unknown) => unknown>)[Symbol.for("eve.dynamic")]!;
}

function createSessionHarness(
  sandboxAccess: SandboxAccess,
  sessionId: string,
  options: { readonly parentSessionId?: string } = {},
) {
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
  if (parent !== undefined) ctx.set(ParentSessionKey, parent as never);
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
      turnAgent: { model: "openai/gpt-5.4", tools: new Map() },
    } as never),
  );

  let line = 0;
  let currentTurnId = "turn_0";
  const conversation: { role: "user" | "assistant"; content: string; kind?: string }[] = [];
  enterSessionProjection(ctx, undefined);

  async function emit(events: readonly Record<string, unknown>[]) {
    const positionLine = line;
    line += 1;
    const at = new Date().toISOString();
    const facts = events.map((event, index) => ({
      ...event,
      meta: { at, id: `evt_${positionLine}_${index}`, position: { index, line: positionLine } },
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
      runEffects(ctx, { conversation: conversation as never, written: written as never }),
    );
  }

  return {
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
          data: { turnId, cause: { deliveryId: `del_${turnId}` }, follows },
        },
      ]);
    },
    async settleToolCall({
      callId,
      name,
      input,
      output,
    }: {
      readonly callId: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly output?: Record<string, unknown>;
    }) {
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
          data: { callId, outcome: "completed", output: output ?? { ok: true } },
        },
      ]);
    },
    async nextModelCall() {
      const beforeCount = conversation.length;
      return await contextStorage.run(ctx, async () => {
        await evaluateValues(ctx, { conversation: conversation as never });
        const draft = await stepDraft({
          config: { tools: new Map() },
          ctx,
          finalReplyOnly: false,
          session: { rootSessionId: sessionId },
        } as never);
        const result = await stepMessages(draft, {
          call: {
            currentInput: new Set(),
            historyState: ctx.get(HistoryStateKey) ?? {},
            record: conversation as never,
          },
          project: (record) => [...record],
        });
        ctx.set(HistoryStateKey, result.historyState);
        conversation.length = 0;
        for (const msg of result.record) {
          conversation.push(msg as (typeof conversation)[number]);
        }
        return {
          newUserInstructions: conversation
            .slice(beforeCount)
            .filter((msg) => msg.role === "user" && msg.kind === "context.instruction")
            .map((msg) => msg.content),
        };
      });
    },
    compactHistory() {
      conversation.length = 0;
      conversation.push({ role: "user", content: "Compacted summary of earlier work." });
      ctx.set(
        HistoryStateKey,
        keptAnnouncements(ctx.get(HistoryStateKey) ?? {}, conversation as never),
      );
    },
  };
}

test("post-clone sparse repo A, repo B deduplication, scoped AGENTS.md caching, compaction re-injection, and subagent inheritance", async () => {
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

    const onEnterParents: (string | undefined)[] = [];
    extension({
      repositories: {
        rules: [
          {
            match: (repo) => repo.root.endsWith("/repoA"),
            onEnter(_repo, ctx) {
              onEnterParents.push(ctx.session.parent?.sessionId);
              return { instructions: "Custom onEnter note for Repo A." };
            },
          },
        ],
      },
    });

    const sandbox = createRealSandboxAccess(workspace);
    const parent = createSessionHarness(sandbox.access, "session-parent");

    await parent.startTurn("turn_1");
    assert.deepEqual((await parent.nextModelCall()).newUserInstructions, []);
    assert.equal(sandbox.commands.length, 1);

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
    assert.equal(step2.newUserInstructions.length, 1);
    assert.match(step2.newUserInstructions[0] ?? "", /<repository_rules/u);
    assert.match(step2.newUserInstructions[0] ?? "", /Custom onEnter note for Repo A\./u);
    assert.match(step2.newUserInstructions[0] ?? "", /Repo A root rules from HEAD\./u);
    assert.match(step2.newUserInstructions[0] ?? "", /source="git"/u);
    assert.deepEqual(onEnterParents, [undefined]);

    await git(workspace, ["clone", `file://${upstreamB}`, join(workspace, "repoB")]);
    await parent.settleToolCall({
      callId: "call_clone_b",
      name: "bash",
      input: { command: `git clone file://${upstreamB} repoB` },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });
    const step3 = await parent.nextModelCall();
    assert.equal(step3.newUserInstructions.length, 1);
    assert.match(step3.newUserInstructions[0] ?? "", /Repo B root rules\./u);
    assert.doesNotMatch(step3.newUserInstructions[0] ?? "", /Repo A root rules/u);

    await parent.settleToolCall({
      callId: "call_read_sub_1",
      name: "read_file",
      input: { filePath: "repoA/packages/sub/index.ts" },
      output: { path: join(workspace, "repoA", "packages", "sub", "index.ts") },
    });
    const step4 = await parent.nextModelCall();
    assert.equal(step4.newUserInstructions.length, 1);
    assert.match(step4.newUserInstructions[0] ?? "", /<scoped_instructions/u);
    assert.match(step4.newUserInstructions[0] ?? "", /Repo A subpackage rules\./u);

    const commandsBeforeRepeat = sandbox.commands.length;
    await parent.settleToolCall({
      callId: "call_read_sub_2",
      name: "read_file",
      input: { filePath: "repoA/packages/sub/other.ts" },
      output: { path: join(workspace, "repoA", "packages", "sub", "other.ts") },
    });
    const step5 = await parent.nextModelCall();
    assert.equal(sandbox.commands.length, commandsBeforeRepeat);
    assert.deepEqual(step5.newUserInstructions, []);

    parent.compactHistory();
    const afterCompaction = (await parent.nextModelCall()).newUserInstructions.join("\n");
    assert.match(afterCompaction, /Repo A root rules from HEAD\./u);
    assert.match(afterCompaction, /Repo B root rules\./u);
    assert.match(afterCompaction, /Repo A subpackage rules\./u);

    const subagent = createSessionHarness(sandbox.access, "session-subagent", {
      parentSessionId: "session-parent",
    });
    await subagent.startTurn("sub_turn_1");
    const subCombined = (await subagent.nextModelCall()).newUserInstructions.join("\n");
    assert.match(subCombined, /Repo A root rules from HEAD\./u);
    assert.match(subCombined, /Repo B root rules\./u);
    assert.deepEqual(onEnterParents, [undefined, "session-parent"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("pre-seeded workspace runs onEnter once and injects instructions on Turn 1 without duplicate scans", async () => {
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
              return { instructions: `Loaded ${extra?.relativePath ?? "none"} on enter.` };
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
    assert.equal(sandbox.commands.length, commandsAfterTurnStart);
    assert.equal(call1.newUserInstructions.length, 1);
    assert.match(call1.newUserInstructions[0] ?? "", /Pre-seeded workspace rules\./u);
    assert.match(call1.newUserInstructions[0] ?? "", /Contribution guidelines\./u);
    assert.match(call1.newUserInstructions[0] ?? "", /Loaded CONTRIBUTING\.md on enter\./u);

    await session.startTurn("turn_2");
    assert.equal(enteredCount, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("discoverOnStart on-sandbox-use stays idle on Turn 1 and non-sandbox tools, then syncs when sandbox opens mid-turn", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-lazy-")));
  try {
    const workspace = join(root, "workspace");
    await initUpstreamRepo(workspace, { "AGENTS.md": "Lazy workspace rules.\n" });
    extension({ repositories: { discoverOnStart: "on-sandbox-use" } });

    const sandbox = createRealSandboxAccess(workspace);
    const session = createSessionHarness(sandbox.access, "session-lazy");

    await session.startTurn("turn_1");
    assert.deepEqual((await session.nextModelCall()).newUserInstructions, []);
    assert.equal(sandbox.getOpenCount(), 0);
    assert.equal(sandbox.commands.length, 0);

    await session.settleToolCall({
      callId: "call_external_fetch",
      name: "crm__run",
      input: { command: "fetch" },
      output: { ok: true },
    });
    assert.equal(sandbox.getOpenCount(), 0);
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

test("HEAD change prunes deleted scopes, delete + re-clone re-runs onEnter, grep loads scoped AGENTS.md, and stale rule.files clear", async () => {
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
          { match: (repo) => repo.branch === "main", files: ["MAIN_ONLY.md"] },
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
      output: { path: join(workspace, "app", "sub") },
    });
    assert.match((await session.nextModelCall()).newUserInstructions[0] ?? "", /Sub v1\./u);

    await git(cloneDir, ["checkout", "-b", "feature/x"]);
    await rm(join(cloneDir, "sub", "AGENTS.md"));
    await writeFile(join(cloneDir, "AGENTS.md"), "Root v2.\n");
    await git(cloneDir, ["add", "-A"]);
    await git(cloneDir, ["commit", "-m", "drop sub agents"]);

    await session.settleToolCall({
      callId: "call_checkout_feature",
      name: "bash",
      input: { command: "git -C app checkout feature/x" },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });
    const call3 = await session.nextModelCall();
    assert.equal(enterCount, 1);
    assert.match(call3.newUserInstructions[0] ?? "", /Root v2\./u);
    assert.doesNotMatch(call3.newUserInstructions[0] ?? "", /Main branch checklist\./u);

    session.compactHistory();
    const afterHead = (await session.nextModelCall()).newUserInstructions.join("\n");
    assert.match(afterHead, /Root v2\./u);
    assert.doesNotMatch(afterHead, /Sub v1\./u);

    await rm(cloneDir, { force: true, recursive: true });
    await session.startTurn("turn_2");

    await git(workspace, ["clone", `file://${upstream}`, cloneDir]);
    await session.settleToolCall({
      callId: "call_reclone",
      name: "bash",
      input: { command: `git clone file://${upstream} app` },
      output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
    });
    const callReclone = await session.nextModelCall();
    assert.equal(enterCount, 2);
    assert.match(callReclone.newUserInstructions[0] ?? "", /Enter #2/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("syncAfter, background bash guard, throwing rule isolation, read-only 0-RPC calls, same-HEAD rule.files refresh, and rule overflow", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-lifecycle-edge-")));
  try {
    const upstreamA = join(root, "upstream-a");
    const upstreamB = join(root, "upstream-b");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await initUpstreamRepo(upstreamA, {
      "AGENTS.md": "Repo A rules.\n",
      "RULE.md": `${"r".repeat(2500)}\n`,
    });
    await initUpstreamRepo(upstreamB, { "AGENTS.md": "SyncAfter B rules.\n" });

    const syncTool = defineTool({
      description: "Custom workspace sync",
      inputSchema: {},
      execute: () => ({ ok: true }),
    });
    registerDefinitionSource(syncTool, { kind: "tool", name: "custom_sync" });

    let enterCalls = 0;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    try {
      extension({
        repositories: {
          maxTotalBytes: 2000,
          syncAfter: [syncTool],
          rules: [
            {
              match() {
                throw new Error("boom in match predicate");
              },
              onEnter: () => ({ instructions: "Never runs" }),
            },
            {
              onEnter() {
                enterCalls += 1;
                throw new Error("boom in first rule");
              },
            },
            {
              files: ["RULE.md"],
              onEnter: (repo) => ({ instructions: `Entered ${repo.root.split("/").at(-1)}.` }),
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
        output: { status: "running", stdout: "", stderr: "", truncated: false },
      });
      assert.equal(enterCalls, 0);

      const commandsBeforeReadOnly = sandbox.commands.length;
      for (const [id, command] of [
        ["ro_1", "git status"],
        ["ro_2", "cd app && pnpm test"],
        ["ro_3", "gh pr view 123"],
        ["ro_4", 'rg "fetch(" src/'],
      ] as const) {
        await session.settleToolCall({
          callId: id,
          name: "bash",
          input: { command },
          output: { exitCode: 0, status: "completed", stdout: "", stderr: "" },
        });
      }
      assert.equal(sandbox.commands.length, commandsBeforeReadOnly);

      const bgA = join(workspace, "bgA");
      await git(workspace, ["clone", `file://${upstreamA}`, bgA]);
      await session.startTurn("turn_2");
      const turn2Text = (await session.nextModelCall()).newUserInstructions.join("\n");
      assert.equal(enterCalls, 1);
      assert.match(turn2Text, /Repo A rules\./u);
      assert.match(turn2Text, /Entered bgA\./u);
      assert.match(turn2Text, /exceeded the automatic instruction byte budget/u);
      assert.match(turn2Text, /RULE\.md/u);
      assert.ok(warnings.some((w) => w.includes("boom in match predicate")));
      assert.ok(warnings.some((w) => w.includes("boom in first rule")));

      await writeFile(join(bgA, "RULE.md"), "Updated same-HEAD rule.\n");
      await session.startTurn("turn_3");
      const turn3Text = (await session.nextModelCall()).newUserInstructions.join("\n");
      assert.match(turn3Text, /Updated same-HEAD rule\./u);

      await git(workspace, ["clone", `file://${upstreamB}`, join(workspace, "syncB")]);
      await session.settleToolCall({
        callId: "call_custom_sync",
        name: "custom_sync",
        input: {},
        output: { ok: true },
      });
      const afterSyncText = (await session.nextModelCall()).newUserInstructions.join("\n");
      assert.match(afterSyncText, /SyncAfter B rules\./u);
      assert.match(afterSyncText, /Entered syncB\./u);
    } finally {
      console.warn = origWarn;
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
