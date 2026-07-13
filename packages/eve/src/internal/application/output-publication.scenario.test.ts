import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  publishApplicationBuildArtifacts,
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
      publishApplicationBuildArtifacts({
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir,
        stagedSummaryPath,
        onAfterOutputInstall() {
          throw new Error("injected publication failure");
        },
      }),
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

    const first = publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: firstOutputDir,
      stagedSummaryPath: firstSummaryPath,
      async onAfterBackup() {
        entered.push("first");
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    });
    await firstEntered.promise;
    const second = publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: secondOutputDir,
      stagedSummaryPath: secondSummaryPath,
      onLockContention() {
        secondObservedContention.resolve();
      },
      onAfterBackup() {
        entered.push("second");
      },
    });

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
    const interruptedToken = "interrupted-owner";
    const outputBackupPath = `${finalOutputDir}.eve-backup-${interruptedToken}`;
    const summaryBackupPath = `${finalSummaryPath}.eve-backup-${interruptedToken}`;
    await writePublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublication({
      outputDir: interruptedOutputDir,
      outputMarker: "interrupted",
      summaryMarker: "interrupted",
      summaryPath: interruptedSummaryPath,
    });
    await writePublication({
      outputDir: nextOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: nextSummaryPath,
    });
    await Promise.all([
      rename(finalOutputDir, outputBackupPath),
      rename(finalSummaryPath, summaryBackupPath),
    ]);
    const lockPath = resolveOutputPublicationLockPath(appRoot);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        finalOutputDir,
        finalSummaryPath,
        hadOutput: true,
        hadSummary: true,
        outputBackupPath,
        phase: "backed-up",
        pid: 2_147_483_647,
        stagedOutputDir: interruptedOutputDir,
        stagedSummaryPath: interruptedSummaryPath,
        startedAt: new Date(0).toISOString(),
        summaryBackupPath,
        token: interruptedToken,
      })}\n`,
    );

    await expect(
      publishApplicationBuildArtifacts({
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir: nextOutputDir,
        stagedSummaryPath: nextSummaryPath,
        onAfterBackup() {
          throw new Error("stop after recovery");
        },
      }),
    ).rejects.toThrow("stop after recovery");

    await expectPublication({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
  });
});
