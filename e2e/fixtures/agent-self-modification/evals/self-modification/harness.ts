import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { EveEvalContext, EveEvalLiveTurn, EveEvalSession, EveEvalTurn } from "eve/evals";

const SELF_MODIFICATION_AGENT = "self-modification__agent";
const CLEANUP_TIMEOUT_MS = 30_000;
const LOCK_DIRECTORY = ".eve-self-modification-eval.lock";
// Each eval entry bundles its relative imports separately. Share the lock across those copies.
const shared = globalThis as typeof globalThis & {
  __eveSelfModificationEvalIsolation?: { previousCleanup: Promise<void>; failure?: unknown };
};
const isolation = (shared.__eveSelfModificationEvalIsolation ??= {
  previousCleanup: Promise.resolve(),
});

export interface SelfModificationRun {
  readonly child: EveEvalTurn;
  readonly parent: EveEvalTurn;
  readonly session: EveEvalSession;
}

/** Serializes source mutation, including cleanup that outlives an eval timeout. */
export async function withSelfModification(
  t: EveEvalContext,
  test: (harness: SelfModificationHarness) => Promise<void>,
): Promise<void> {
  if (t.target.kind !== "local") {
    t.skip("Self-modification evals require a local development target.");
  }

  const preceding = isolation.previousCleanup;
  let release!: () => void;
  isolation.previousCleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  await preceding;
  let checkoutLock: Awaited<ReturnType<typeof acquireCheckoutLock>> | undefined;
  let retainCheckoutLock = false;
  try {
    t.signal.throwIfAborted();
    if (isolation.failure !== undefined) {
      throw new Error("A previous self-modification eval could not clean up safely.", {
        cause: isolation.failure,
      });
    }
    checkoutLock = await acquireCheckoutLock(process.cwd());
    const harness = await SelfModificationHarness.create(t, {
      onBackupCreated: checkoutLock.recordBackup,
    });
    let failure: { error: unknown } | undefined;
    try {
      await test(harness);
    } catch (error) {
      failure = { error };
    }
    try {
      await harness.close();
    } catch (error) {
      isolation.failure = error;
      retainCheckoutLock = true;
      if (failure !== undefined) {
        throw new AggregateError(
          [failure.error, error],
          "Self-modification eval and cleanup failed.",
        );
      }
      throw error;
    }
    if (failure !== undefined) throw failure.error;
  } finally {
    try {
      if (!retainCheckoutLock) await checkoutLock?.release();
    } finally {
      release();
    }
  }
}

export class SelfModificationHarness {
  readonly #t: EveEvalContext;
  readonly #sourceRoot: string;
  readonly #backupRoot: string;
  readonly #turns = new Set<EveEvalLiveTurn>();

  private constructor(t: EveEvalContext, sourceRoot: string, backupRoot: string) {
    this.#t = t;
    this.#sourceRoot = sourceRoot;
    this.#backupRoot = backupRoot;
  }

  static async create(
    t: EveEvalContext,
    sourceRootOrOptions:
      | string
      | {
          sourceRoot?: string;
          onBackupCreated?: (backupRoot: string) => Promise<void>;
        } = {},
  ): Promise<SelfModificationHarness> {
    const options =
      typeof sourceRootOrOptions === "string"
        ? { sourceRoot: sourceRootOrOptions }
        : sourceRootOrOptions;
    const sourceRoot = options.sourceRoot ?? join(process.cwd(), "agent");
    const backupRoot = await mkdtemp(join(tmpdir(), "eve-selfmod-eval-"));
    try {
      await options.onBackupCreated?.(backupRoot);
      await cp(sourceRoot, join(backupRoot, "agent"), { recursive: true, verbatimSymlinks: true });
      return new SelfModificationHarness(t, sourceRoot, backupRoot);
    } catch (error) {
      await rm(backupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async request(
    prompt: string,
    session?: Pick<EveEvalSession, "start">,
  ): Promise<SelfModificationRun> {
    const liveParent = await (session ?? (await this.#t.session())).start(prompt);
    this.#turns.add(liveParent);
    const parent = await liveParent.result();
    parent.expectOk();
    const call = parent.requireToolCall(SELF_MODIFICATION_AGENT);
    const agentId = typeof call.input.agentId === "string" ? call.input.agentId : undefined;
    const message = agentId === undefined ? undefined : call.input.message;
    if (agentId !== undefined && (typeof message !== "string" || message.length === 0))
      throw new Error("Self-modification continuation omitted its message.");

    let called = [...this.#turns]
      .filter((turn) => turn.sessionId === parent.sessionId)
      .flatMap((turn) => turn.events)
      .find(
        (event) =>
          event.type === "subagent.called" &&
          event.data.name === SELF_MODIFICATION_AGENT &&
          (agentId === undefined
            ? liveParent.events.includes(event)
            : event.data.agentId === agentId),
      );
    let continuation: EveEvalLiveTurn | undefined;
    if (called?.type !== "subagent.called") {
      continuation = this.#t.target.watchTurn(parent.sessionId, {
        startIndex: liveParent.session.state.streamIndex,
      });
      this.#turns.add(continuation);
      const data: { name: string; agentId?: string } = { name: SELF_MODIFICATION_AGENT };
      if (agentId !== undefined) data.agentId = agentId;
      called = await continuation.waitForEvent("subagent.called", { data });
    }
    const [child] = await Promise.all([
      this.#readChild(
        called.data.childSessionId,
        typeof message === "string" ? message : undefined,
      ),
      continuation?.result().then((turn) => turn.expectOk()),
    ]);
    this.#t.calledSubagent(SELF_MODIFICATION_AGENT);
    return { child, parent, session: liveParent.session };
  }

  followUp(session: EveEvalSession, prompt: string): Promise<EveEvalTurn> {
    return this.#runTurn(session, prompt);
  }

  /** Uses a fresh conversation so the model cannot answer from the authoring exchange alone. */
  async verify(prompt: string): Promise<EveEvalTurn> {
    return this.#runTurn(await this.#t.session(), prompt);
  }

  async apply(): Promise<void> {
    const response = await this.#post("rebuild?force=1", this.#t.signal);
    const body = (await response.json()) as { revision?: unknown };
    if (typeof body.revision !== "string" || body.revision.length === 0) {
      throw new Error("Self-modification rebuild did not return a runtime revision.");
    }
    this.#t.log(`Self-modification runtime revision: ${body.revision}`);
  }

  async assertOnlyChanged(sourcePaths: readonly string[]): Promise<void> {
    const original = await sourceFiles(join(this.#backupRoot, "agent"));
    const current = await sourceFiles(this.#sourceRoot);
    for (const path of new Set([...original.keys(), ...current.keys()])) {
      if (sourcePaths.includes(path)) continue;
      const before = original.get(path);
      const after = current.get(path);
      if (before === undefined || after === undefined || !before.equals(after)) {
        throw new Error(`Self-modification changed an unrelated source file: ${path}`);
      }
    }
  }

  readSource(sourcePath: string): Promise<string> {
    return readFile(this.#resolve(sourcePath), "utf8");
  }

  async writeSource(sourcePath: string, content: string): Promise<void> {
    const path = this.#resolve(sourcePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async close(): Promise<void> {
    // Reset retires sessions and waits for their command hooks to close; cancel only requests it.
    // Discover even children emitted just before a failed/aborted parent stream was observed.
    const sessionIds = new Set<string>();
    for (const turn of this.#turns) {
      sessionIds.add(turn.sessionId);
      for (const event of turn.events) {
        if (event.type === "subagent.called") sessionIds.add(event.data.childSessionId);
      }
    }
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    const results = await Promise.allSettled(
      [...sessionIds].map(async (sessionId) => {
        const response = await this.#t.target.fetch(
          `/eve/v1/session/${encodeURIComponent(sessionId)}/reset`,
          {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Self-modification eval cleanup" }),
          },
        );
        if (!response.ok)
          throw new Error(`Failed to retire self-modification session: ${response.status}`);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Sessions could not be retired; source backup retained at ${this.#backupRoot}`,
      );
    }

    const lease = randomUUID();
    await this.#post(`suspend?lease=${lease}`, signal);
    try {
      await rm(this.#sourceRoot, { recursive: true, force: true });
      await cp(join(this.#backupRoot, "agent"), this.#sourceRoot, {
        recursive: true,
        verbatimSymlinks: true,
      });
    } finally {
      await this.#post(`resume?lease=${lease}`, signal);
    }
    await this.#post("rebuild?force=1", signal);
    await rm(this.#backupRoot, { recursive: true, force: true });
  }

  async #readChild(sessionId: string, message?: string): Promise<EveEvalTurn> {
    let startIndex =
      [...this.#turns].reverse().find((turn) => turn.sessionId === sessionId)?.session.state
        .streamIndex ?? 0;
    for (let turns = 0; turns < 16; turns++) {
      this.#t.signal.throwIfAborted();
      const live = this.#t.target.watchTurn(sessionId, { startIndex });
      this.#turns.add(live);
      const turn = await live.result();
      turn.expectOk();
      // A reused child may have unseen diagnostic turns. Wait for the turn
      // that actually received this delegation, including mid-turn steering.
      if (
        message === undefined ||
        turn.events.some(
          (event) => event.type === "message.received" && event.data.message?.includes(message),
        )
      )
        return turn;
      if (turn.status !== "waiting") break;
      startIndex = live.session.state.streamIndex;
    }
    throw new Error("Self-modification child did not receive the delegated message.");
  }

  async #runTurn(session: EveEvalSession, prompt: string): Promise<EveEvalTurn> {
    const live = await session.start(prompt);
    this.#turns.add(live);
    const turn = await live.result();
    turn.expectOk();
    return turn;
  }

  #resolve(sourcePath: string): string {
    if (!sourcePath || sourcePath.startsWith("/") || sourcePath.split(/[\\/]/u).includes("..")) {
      throw new Error(`Self-modification eval source paths must be relative: ${sourcePath}`);
    }
    return join(this.#sourceRoot, sourcePath);
  }

  async #post(operation: string, signal: AbortSignal): Promise<Response> {
    const response = await this.#t.target.fetch(`/eve/v1/dev/runtime-artifacts/${operation}`, {
      method: "POST",
      signal,
    });
    if (!response.ok) throw new Error(`Self-modification ${operation} failed: ${response.status}`);
    return response;
  }
}

async function acquireCheckoutLock(root: string): Promise<{
  recordBackup: (backupRoot: string) => Promise<void>;
  release: () => Promise<void>;
}> {
  const lockDirectory = join(root, LOCK_DIRECTORY);
  const owner = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Another self-modification eval owns this checkout. Remove ${lockDirectory} only after confirming no eval or development server is mutating it.`,
      );
    }
    throw error;
  }
  const writeOwner = (backupRoot?: string) =>
    writeFile(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({ ...owner, backupRoot }, null, 2)}\n`,
    );
  try {
    await writeOwner();
  } catch (error) {
    await rm(lockDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    recordBackup: writeOwner,
    release: () => rm(lockDirectory, { recursive: true, force: true }),
  };
}

async function sourceFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let entries = 0;
  let bytes = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error("Self-modification source exceeds 16 nested directories.");
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (++entries > 256) throw new Error("Self-modification source exceeds 256 entries.");
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const absolute = join(root, path);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else {
        const stat = await lstat(absolute);
        bytes += stat.size;
        if (bytes > 4 * 1024 * 1024) throw new Error("Self-modification source exceeds 4 MiB.");
        if (!stat.isFile() && !stat.isSymbolicLink())
          throw new Error(`Unexpected source entry: ${path}`);
        const content = entry.isSymbolicLink()
          ? Buffer.from(`symlink:${await readlink(absolute)}`)
          : await readFile(absolute);
        files.set(path, Buffer.concat([Buffer.from(`${stat.mode}:`), content]));
      }
    }
  }
  await visit("", 0);
  return files;
}
