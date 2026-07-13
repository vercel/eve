import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  publishApplicationBuildArtifacts,
  publishApplicationBuildArtifactsWithObserver,
  resolveOutputPublicationLockPath,
} from "#internal/application/output-publication.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

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

async function interruptPublicationAfterBackup(input: {
  readonly appRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
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
    outputDir: input.stagedOutputDir,
    outputMarker: "interrupted",
    summaryMarker: "interrupted",
    summaryPath: input.stagedSummaryPath,
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
      pid: 2_147_483_647,
      stagedOutputDir: input.stagedOutputDir,
      stagedSummaryPath: input.stagedSummaryPath,
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
    const stagedOutputDir = join(appRoot, ".eve", "builds", "next", "output");
    const stagedSummaryPath = join(appRoot, ".eve", "builds", "next", "summary.json");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "previous",
      summaryMarker: "previous",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: stagedSummaryPath,
    });

    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir,
      stagedSummaryPath,
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
    const stagedOutputDir = join(appRoot, ".eve", "builds", "failed", "output");
    const stagedSummaryPath = join(appRoot, ".eve", "builds", "failed", "summary.json");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: stagedOutputDir,
      outputMarker: "failed",
      summaryMarker: "failed",
      summaryPath: stagedSummaryPath,
    });

    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          stagedOutputDir,
          stagedSummaryPath,
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
      outputDir: stagedOutputDir,
      outputMarker: "failed",
      summaryMarker: "failed",
      summaryPath: stagedSummaryPath,
    });
  });

  it("keeps the publication lock owned until the current publisher releases it", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-lock-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const firstOutputDir = join(appRoot, ".eve", "builds", "first", "output");
    const firstSummaryPath = join(appRoot, ".eve", "builds", "first", "summary.json");
    const secondOutputDir = join(appRoot, ".eve", "builds", "second", "output");
    const secondSummaryPath = join(appRoot, ".eve", "builds", "second", "summary.json");
    await writePublication({
      outputDir: firstOutputDir,
      outputMarker: "first",
      summaryMarker: "first",
      summaryPath: firstSummaryPath,
    });
    await writePublication({
      outputDir: secondOutputDir,
      outputMarker: "second",
      summaryMarker: "second",
      summaryPath: secondSummaryPath,
    });
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondObservedContention = Promise.withResolvers<void>();
    const entered: string[] = [];

    const first = publishApplicationBuildArtifactsWithObserver(
      {
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir: firstOutputDir,
        stagedSummaryPath: firstSummaryPath,
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
    const second = publishApplicationBuildArtifactsWithObserver(
      {
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir: secondOutputDir,
        stagedSummaryPath: secondSummaryPath,
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
    await Promise.all([first, second]);

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
    const interruptedOutputDir = join(appRoot, ".eve", "builds", "interrupted", "output");
    const interruptedSummaryPath = join(appRoot, ".eve", "builds", "interrupted", "summary.json");
    const nextOutputDir = join(appRoot, ".eve", "builds", "next", "output");
    const nextSummaryPath = join(appRoot, ".eve", "builds", "next", "summary.json");
    await interruptPublicationAfterBackup({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: interruptedOutputDir,
      stagedSummaryPath: interruptedSummaryPath,
    });
    await writePublication({
      outputDir: nextOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: nextSummaryPath,
    });
    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          stagedOutputDir: nextOutputDir,
          stagedSummaryPath: nextSummaryPath,
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
  });

  it("retains interrupted publication state when recovery itself fails", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-recovery-retry-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const interruptedOutputDir = join(appRoot, ".eve", "builds", "interrupted", "output");
    const interruptedSummaryPath = join(appRoot, ".eve", "builds", "interrupted", "summary.json");
    const firstOutputDir = join(appRoot, ".eve", "builds", "first", "output");
    const firstSummaryPath = join(appRoot, ".eve", "builds", "first", "summary.json");
    const retryOutputDir = join(appRoot, ".eve", "builds", "retry", "output");
    const retrySummaryPath = join(appRoot, ".eve", "builds", "retry", "summary.json");
    await interruptPublicationAfterBackup({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: interruptedOutputDir,
      stagedSummaryPath: interruptedSummaryPath,
    });
    await writePublication({
      outputDir: firstOutputDir,
      outputMarker: "first",
      summaryMarker: "first",
      summaryPath: firstSummaryPath,
    });
    await writePublication({
      outputDir: retryOutputDir,
      outputMarker: "retry",
      summaryMarker: "retry",
      summaryPath: retrySummaryPath,
    });
    try {
      await chmod(appRoot, 0o500);
      await expect(
        publishApplicationBuildArtifacts({
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          stagedOutputDir: firstOutputDir,
          stagedSummaryPath: firstSummaryPath,
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(appRoot, 0o700);
    }

    await expect(
      publishApplicationBuildArtifactsWithObserver(
        {
          appRoot,
          finalOutputDir,
          finalSummaryPath,
          stagedOutputDir: retryOutputDir,
          stagedSummaryPath: retrySummaryPath,
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
    const stagedOutputDir = join(appRoot, ".eve", "builds", "next", "output");
    const stagedSummaryPath = join(appRoot, ".eve", "builds", "next", "summary.json");
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: stagedOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: stagedSummaryPath,
    });

    try {
      await expect(
        publishApplicationBuildArtifactsWithObserver(
          {
            appRoot,
            finalOutputDir,
            finalSummaryPath,
            stagedOutputDir,
            stagedSummaryPath,
          },
          {
            async afterBackup() {},
            async afterOutputInstall() {
              await chmod(appRoot, 0o500);
            },
            async onContention() {},
          },
        ),
      ).rejects.toThrow();
    } finally {
      await chmod(appRoot, 0o700);
    }

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: finalSummaryPath,
    });
    await expect(
      readFile(join(resolveOutputPublicationLockPath(appRoot), "owner.json"), "utf8"),
    ).resolves.toContain('"phase": "committed"');

    const recoveredOutputDir = join(appRoot, ".eve", "builds", "recovered", "output");
    const recoveredSummaryPath = join(appRoot, ".eve", "builds", "recovered", "summary.json");
    await writePublication({
      outputDir: recoveredOutputDir,
      outputMarker: "recovered",
      summaryMarker: "recovered",
      summaryPath: recoveredSummaryPath,
    });
    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: recoveredOutputDir,
      stagedSummaryPath: recoveredSummaryPath,
    });

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "recovered",
      summaryMarker: "recovered",
      summaryPath: finalSummaryPath,
    });
  });
});
