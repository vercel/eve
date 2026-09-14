import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EveEvalContext, EveEvalTurn } from "eve/evals";

const SELF_MODIFICATION_AGENT = "self-modification";

export interface SelfModificationRun {
  readonly child: EveEvalTurn;
  readonly parent: EveEvalTurn;
}

/** Drives a local self-modification while owning source cleanup and runtime rebuilds. */
export async function withSelfModification(
  t: EveEvalContext,
  sourcePaths: readonly string[],
  test: (harness: SelfModificationHarness) => Promise<void>,
): Promise<void> {
  if (t.target.kind !== "local") {
    t.skip("Self-modification evals require a local development target.");
  }

  const harness = await SelfModificationHarness.create(t, sourcePaths);
  await harness.reset();
  try {
    await test(harness);
  } finally {
    await harness.reset();
  }
}

export class SelfModificationHarness {
  readonly #originalSources: ReadonlyMap<string, string | undefined>;
  readonly #t: EveEvalContext;

  private constructor(t: EveEvalContext, originalSources: ReadonlyMap<string, string | undefined>) {
    this.#t = t;
    this.#originalSources = originalSources;
  }

  static async create(
    t: EveEvalContext,
    sourcePaths: readonly string[],
  ): Promise<SelfModificationHarness> {
    return new SelfModificationHarness(
      t,
      new Map(
        await Promise.all(
          sourcePaths.map(
            async (sourcePath) => [sourcePath, await readOptionalSource(sourcePath)] as const,
          ),
        ),
      ),
    );
  }

  async request(prompt: string): Promise<SelfModificationRun> {
    let liveParent = await this.#t.start(prompt);
    const parent = await liveParent.result();
    parent.expectOk();
    parent.calledSubagent(SELF_MODIFICATION_AGENT);

    if (!liveParent.events.some((event) => event.type === "subagent.called")) {
      liveParent = this.#t.target.watchTurn(parent.sessionId, {
        startIndex: liveParent.session.state?.streamIndex,
      });
    }
    const called = await liveParent.waitForEvent("subagent.called", {
      data: { name: SELF_MODIFICATION_AGENT },
    });

    const child = await this.#t.target.watchTurn(called.data.childSessionId).result();
    child.expectOk();
    return { child, parent };
  }

  async apply(): Promise<void> {
    await rebuild(this.#t);
  }

  readSource(sourcePath: string): Promise<string> {
    return readFile(resolveSourcePath(sourcePath), "utf8");
  }

  writeSource(sourcePath: string, content: string): Promise<void> {
    if (!this.#originalSources.has(sourcePath)) {
      throw new Error(`Self-modification eval did not register source path: ${sourcePath}`);
    }
    return writeFile(resolveSourcePath(sourcePath), content, "utf8");
  }

  async reset(): Promise<void> {
    await Promise.all(
      [...this.#originalSources].map(([sourcePath, content]) =>
        content === undefined
          ? rm(resolveSourcePath(sourcePath), { force: true })
          : writeFile(resolveSourcePath(sourcePath), content, "utf8"),
      ),
    );
    await rebuild(this.#t);
  }
}

async function readOptionalSource(sourcePath: string): Promise<string | undefined> {
  try {
    return await readFile(resolveSourcePath(sourcePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function resolveSourcePath(sourcePath: string): string {
  if (sourcePath.startsWith("/") || sourcePath.split("/").includes("..")) {
    throw new Error(`Self-modification eval source paths must be relative: ${sourcePath}`);
  }
  return join(process.cwd(), "agent", sourcePath);
}

async function rebuild(t: EveEvalContext): Promise<void> {
  const response = await t.target.fetch("/eve/v1/dev/runtime-artifacts/rebuild?force=1", {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to rebuild the self-modified agent: ${response.status}`);
  }
}
