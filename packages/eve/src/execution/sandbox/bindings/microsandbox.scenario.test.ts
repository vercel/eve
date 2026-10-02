import { existsSync } from "node:fs";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox.js";

// Microsandbox is unsupported on Windows (native bindings ship for
// macOS Apple Silicon and glibc Linux only). Template pruning operates on
// the on-disk metadata cache and only touches the microsandbox runtime
// when it is already installed, so it needs no VM.
const onWindows = process.platform === "win32";

const createScratchDirectory = useTemporaryDirectories();

describe.skipIf(onWindows)("pruneMicrosandboxTemplates", () => {
  it("prunes stale cached templates while preserving retained and recent templates", async () => {
    // The provider derives its cache directory from `appRoot` via
    // `resolveSandboxCacheDirectory`, so the test builds the cache under a
    // temporary appRoot.
    const appRoot = await createScratchDirectory("eve-microsandbox-template-prune-");
    const templatesRoot = join(appRoot, ".eve", "sandbox-cache", "microsandbox", "templates");
    const recentTemplateRoot = join(templatesRoot, "recent");
    const retainedTemplateRoot = join(templatesRoot, "retained");
    const staleTemplateRoot = join(templatesRoot, "stale");
    const staleTemporaryRoot = join(templatesRoot, "stale-publish.tmp");
    const recentTemporaryRoot = join(templatesRoot, "recent-publish.tmp");
    const now = 1_000_000;

    for (const templateRoot of [
      recentTemplateRoot,
      retainedTemplateRoot,
      staleTemplateRoot,
      staleTemporaryRoot,
      recentTemporaryRoot,
    ]) {
      await mkdir(templateRoot, { recursive: true });
      await writeFile(join(templateRoot, "marker.txt"), templateRoot);
    }
    await utimes(recentTemplateRoot, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(retainedTemplateRoot, new Date(now - 20_000), new Date(now - 20_000));
    await utimes(staleTemplateRoot, new Date(now - 30_000), new Date(now - 30_000));
    await utimes(staleTemporaryRoot, new Date(now - 30_000), new Date(now - 30_000));
    await utimes(recentTemporaryRoot, new Date(now - 1_000), new Date(now - 1_000));

    await pruneMicrosandboxTemplates({
      appRoot,
      now,
      recentWindowMs: 5_000,
      retainCount: 2,
    });

    await expect(readdir(templatesRoot)).resolves.toEqual(
      expect.arrayContaining(["recent", "retained", "recent-publish.tmp"]),
    );
    expect(existsSync(staleTemplateRoot)).toBe(false);
    expect(existsSync(staleTemporaryRoot)).toBe(false);
  });
});
