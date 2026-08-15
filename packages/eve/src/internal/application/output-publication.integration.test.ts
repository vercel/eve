import { mkdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  publishApplicationBuildArtifacts,
  publishApplicationBuildArtifactsWithObserver,
  resolveOutputPublicationLockPath,
} from "#internal/application/output-publication.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

const fileSystemFaults = vi.hoisted(() => ({
  atomicWrite: undefined as ((targetPath: string) => Error | undefined) | undefined,
  rename: undefined as
    | ((sourcePath: string, destinationPath: string) => Error | undefined)
    | undefined,
  rm: undefined as ((path: string) => Error | undefined) | undefined,
}));

vi.mock("#shared/atomic-write-file.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#shared/atomic-write-file.js")>();
  return {
    ...original,
    async atomicWriteFile(...input: Parameters<typeof original.atomicWriteFile>) {
      const error = fileSystemFaults.atomicWrite?.(input[0]);
      if (error !== undefined) {
        throw error;
      }
      return original.atomicWriteFile(...input);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async rename(...input: Parameters<typeof original.rename>) {
      const error = fileSystemFaults.rename?.(String(input[0]), String(input[1]));
      if (error !== undefined) {
        throw error;
      }
      return original.rename(...input);
    },
    async rm(...input: Parameters<typeof original.rm>) {
      const error = fileSystemFaults.rm?.(String(input[0]));
      if (error !== undefined) {
        throw error;
      }
      return original.rm(...input);
    },
  };
});

afterEach(() => {
  fileSystemFaults.atomicWrite = undefined;
  fileSystemFaults.rename = undefined;
  fileSystemFaults.rm = undefined;
});

interface StagedBuild {
  readonly scratchDir: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
}

function stagedBuild(appRoot: string, buildName: string): StagedBuild {
  const scratchDir = join(appRoot, ".eve", "builds", buildName);
  return {
    scratchDir,
    stagedOutputDir: join(scratchDir, "output"),
    stagedSummaryPath: join(scratchDir, "summary.json"),
  };
}

async function writePublication(input: {
  readonly outputDir: string;
  readonly outputMarker: string;
  readonly summaryMarker: string;
  readonly summaryPath: string;
}): Promise<void> {
  await Promise.all([
    mkdir(input.outputDir, { recursive: true }),
    mkdir(join(input.summaryPath, ".."), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(input.outputDir, "marker.txt"), `${input.outputMarker}\n`),
    writeFile(input.summaryPath, `${input.summaryMarker}\n`),
  ]);
}

async function expectPublication(input: {
  readonly outputDir: string;
  readonly outputMarker: string;
  readonly summaryMarker: string;
  readonly summaryPath: string;
}): Promise<void> {
  await expect(readFile(join(input.outputDir, "marker.txt"), "utf8")).resolves.toBe(
    `${input.outputMarker}\n`,
  );
  await expect(readFile(input.summaryPath, "utf8")).resolves.toBe(`${input.summaryMarker}\n`);
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function interruptPublicationAfterBackup(input: {
  readonly appRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly interrupted: StagedBuild;
  readonly pid?: number;
}): Promise<void> {
  const token = "interrupted-owner";
  const outputBackupPath = `${input.finalOutputDir}.eve-backup-${token}`;
  const summaryBackupPath = `${input.finalSummaryPath}.eve-backup-${token}`;
  await writePublication({
    outputDir: input.finalOutputDir,
    outputMarker: "last-good",
    summaryMarker: "last-good",
    summaryPath: input.finalSummaryPath,
  });
  await writePublication({
    outputDir: input.interrupted.stagedOutputDir,
    outputMarker: "interrupted",
    summaryMarker: "interrupted",
    summaryPath: input.interrupted.stagedSummaryPath,
  });
  await Promise.all([
    rename(input.finalOutputDir, outputBackupPath),
    rename(input.finalSummaryPath, summaryBackupPath),
  ]);
  const lockPath = resolveOutputPublicationLockPath(input.appRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({
      finalOutputDir: input.finalOutputDir,
      finalSummaryPath: input.finalSummaryPath,
      hadOutput: true,
      hadSummary: true,
      liveness: "active",
      outputBackupPath,
      phase: "backed-up",
      pid: input.pid ?? 2_147_483_647,
      scratchDir: input.interrupted.scratchDir,
      stagedOutputDir: input.interrupted.stagedOutputDir,
      stagedSummaryPath: input.interrupted.stagedSummaryPath,
      summaryBackupPath,
      token,
    })}\n`,
  );
}

describe("build output publication", () => {
  it("publishes matching output and summary", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const next = stagedBuild(appRoot, "next");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "previous",
      summaryMarker: "previous",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });

    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      ...next,
    });

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: finalSummaryPath,
    });
  });

  it("restores the complete last-good publication when installation fails", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-rollback-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const failed = stagedBuild(appRoot, "failed");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: failed.stagedOutputDir,
      outputMarker: "failed",
      summaryMarker: "failed",
      summaryPath: failed.stagedSummaryPath,
    });

    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          ...failed,
        },
        {
          async afterBackup() {},
          async afterOutputInstall() {
            throw new Error("injected publication failure");
          },
          async onContention() {},
        },
      ),
    ).rejects.toThrow("injected publication failure");

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await expectPublication({
      outputDir: failed.stagedOutputDir,
      outputMarker: "failed",
      summaryMarker: "failed",
      summaryPath: failed.stagedSummaryPath,
    });
  });

  it("rolls back when the committed journal record cannot be written", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-uncommitted-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const next = stagedBuild(appRoot, "next");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });
    const lockPath = resolveOutputPublicationLockPath(appRoot);

    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          ...next,
        },
        {
          async afterBackup() {},
          async afterOutputInstall() {
            fileSystemFaults.atomicWrite = (targetPath) => {
              if (targetPath !== join(lockPath, "owner.json")) {
                return undefined;
              }
              fileSystemFaults.atomicWrite = undefined;
              return new Error("injected committed journal failure");
            };
          },
          async onContention() {},
        },
      ),
    ).rejects.toThrow("injected committed journal failure");

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await expectPublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });
  });

  it("keeps the publication lock owned until the current publisher releases it", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-lock-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const first = stagedBuild(appRoot, "first");
    const second = stagedBuild(appRoot, "second");
    await writePublication({
      outputDir: first.stagedOutputDir,
      outputMarker: "first",
      summaryMarker: "first",
      summaryPath: first.stagedSummaryPath,
    });
    await writePublication({
      outputDir: second.stagedOutputDir,
      outputMarker: "second",
      summaryMarker: "second",
      summaryPath: second.stagedSummaryPath,
    });
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondObservedContention = Promise.withResolvers<void>();
    const entered: string[] = [];

    const firstPublish = publishApplicationBuildArtifactsWithObserver(
      {
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        ...first,
      },
      {
        async afterBackup() {
          entered.push("first");
          firstEntered.resolve();
          await releaseFirst.promise;
        },
        async afterOutputInstall() {},
        async onContention() {},
      },
    );
    await firstEntered.promise;
    const secondPublish = publishApplicationBuildArtifactsWithObserver(
      {
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        ...second,
      },
      {
        async afterBackup() {
          entered.push("second");
        },
        async afterOutputInstall() {},
        async onContention() {
          secondObservedContention.resolve();
        },
      },
    );

    await secondObservedContention.promise;
    expect(entered).toEqual(["first"]);
    releaseFirst.resolve();
    await Promise.all([firstPublish, secondPublish]);

    expect(entered).toEqual(["first", "second"]);
    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "second",
      summaryMarker: "second",
      summaryPath: finalSummaryPath,
    });
  });

  it("recovers an interrupted publication before admitting the next publisher", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-recovery-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const interrupted = stagedBuild(appRoot, "interrupted");
    const next = stagedBuild(appRoot, "next");
    await interruptPublicationAfterBackup({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      interrupted,
    });
    await writePublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });
    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          ...next,
        },
        {
          async afterBackup() {
            throw new Error("stop after recovery");
          },
          async afterOutputInstall() {},
          async onContention() {},
        },
      ),
    ).rejects.toThrow("stop after recovery");

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await expectMissing(interrupted.scratchDir);
  });

  it("recovers an interrupted publication whose owner pid is alive but whose journal went stale", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-stale-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const interrupted = stagedBuild(appRoot, "interrupted");
    const next = stagedBuild(appRoot, "next");
    await interruptPublicationAfterBackup({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      interrupted,
      // The test's own live pid simulates pid reuse: the recorded owner is
      // gone, but `process.kill(pid, 0)` still succeeds.
      pid: process.pid,
    });
    const journalFilePath = join(resolveOutputPublicationLockPath(appRoot), "owner.json");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(journalFilePath, staleTime, staleTime);
    await writePublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });

    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      ...next,
    });

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: finalSummaryPath,
    });
  });

  it("recovers an interrupted publication that targeted a different output directory", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-target-");
    const vercelOutputDir = join(appRoot, ".vercel", "output");
    const vercelSummaryPath = join(appRoot, ".vercel", "agent-summary.json");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const interrupted = stagedBuild(appRoot, "interrupted");
    const next = stagedBuild(appRoot, "next");
    await interruptPublicationAfterBackup({
      appRoot,
      finalOutputDir: vercelOutputDir,
      finalSummaryPath: vercelSummaryPath,
      interrupted,
    });
    await writePublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });

    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      ...next,
    });

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: finalSummaryPath,
    });
    await expectPublication({
      outputDir: vercelOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: vercelSummaryPath,
    });
    await expectMissing(interrupted.scratchDir);
  });

  it("retains interrupted publication state when recovery itself fails", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-recovery-retry-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const interrupted = stagedBuild(appRoot, "interrupted");
    const first = stagedBuild(appRoot, "first");
    const retry = stagedBuild(appRoot, "retry");
    await interruptPublicationAfterBackup({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      interrupted,
    });
    await writePublication({
      outputDir: first.stagedOutputDir,
      outputMarker: "first",
      summaryMarker: "first",
      summaryPath: first.stagedSummaryPath,
    });
    await writePublication({
      outputDir: retry.stagedOutputDir,
      outputMarker: "retry",
      summaryMarker: "retry",
      summaryPath: retry.stagedSummaryPath,
    });
    fileSystemFaults.rename = (sourcePath, destinationPath) => {
      if (
        destinationPath !== finalOutputDir ||
        !sourcePath.startsWith(`${finalOutputDir}.eve-backup-`)
      ) {
        return undefined;
      }
      fileSystemFaults.rename = undefined;
      return new Error("injected recovery failure");
    };
    await expect(
      publishApplicationBuildArtifacts({
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        ...first,
      }),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "injected recovery failure" })],
      message: "Failed to restore the previous build publication.",
    });

    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          ...retry,
        },
        {
          async afterBackup() {
            throw new Error("stop after recovery retry");
          },
          async afterOutputInstall() {},
          async onContention() {},
        },
      ),
    ).rejects.toThrow("stop after recovery retry");

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
  });

  it("retains a recoverable lock when committed backup cleanup fails", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-cleanup-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const next = stagedBuild(appRoot, "next");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: next.stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: next.stagedSummaryPath,
    });

    fileSystemFaults.rm = (path) => {
      if (!path.startsWith(`${finalOutputDir}.eve-backup-`)) {
        return undefined;
      }
      fileSystemFaults.rm = undefined;
      return new Error("injected backup cleanup failure");
    };
    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          ...next,
        },
        {
          async afterBackup() {},
          async afterOutputInstall() {},
          async onContention() {},
        },
      ),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "injected backup cleanup failure" })],
      message: "Build output was committed but backup cleanup failed.",
    });

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: finalSummaryPath,
    });
    await expect(
      readFile(join(resolveOutputPublicationLockPath(appRoot), "owner.json"), "utf8"),
    ).resolves.toContain('"phase": "committed"');

    const recovered = stagedBuild(appRoot, "recovered");
    await writePublication({
      outputDir: recovered.stagedOutputDir,
      outputMarker: "recovered",
      summaryMarker: "recovered",
      summaryPath: recovered.stagedSummaryPath,
    });
    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      ...recovered,
    });

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "recovered",
      summaryMarker: "recovered",
      summaryPath: finalSummaryPath,
    });
  });
});
