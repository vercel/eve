import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMPILED_VENDOR_ROOT = join(EVE_PACKAGE_ROOT, ".generated", "compiled");
const VENDOR_WARNING_LOG_PATH = join(EVE_PACKAGE_ROOT, "scripts", "vendor-warning-log.mjs");

type VendorWarningLog = {
  readonly createVendoredDependencyWarningFilter: () => {
    readonly onLog: (
      level: string,
      log: {
        readonly id?: string;
        readonly loc?: { readonly file?: string };
        readonly message: string;
      },
      defaultHandler: (level: string, log: { readonly message: string }) => void,
    ) => void;
  };
};

async function loadVendorWarningLog(): Promise<VendorWarningLog> {
  return (await import(pathToFileURL(VENDOR_WARNING_LOG_PATH).href)) as VendorWarningLog;
}

function containsSourceMapComment(source: string): boolean {
  return /(?:^|\n)\s*\/\/# sourceMappingURL=/u.test(source);
}

describe("compiled vendor assets", () => {
  it("does not generate source maps for vendored packages", async () => {
    const entries = await readdir(COMPILED_VENDOR_ROOT, {
      recursive: true,
    });
    const sourceMapFiles = entries.filter((entry) => entry.endsWith(".map"));
    const javaScriptFiles = entries.filter((entry) => entry.endsWith(".js"));
    const javaScriptSources = await Promise.all(
      javaScriptFiles.map((entry) => readFile(join(COMPILED_VENDOR_ROOT, entry), "utf8")),
    );

    expect(sourceMapFiles).toEqual([]);
    expect(javaScriptSources.some(containsSourceMapComment)).toBe(false);
  });

  it("suppresses dependency warnings without hiding actionable logs", async () => {
    const { createVendoredDependencyWarningFilter } = await loadVendorWarningLog();
    const forwardedLogs: string[] = [];
    const filter = createVendoredDependencyWarningFilter();
    const dependencyFilePath = join(
      EVE_PACKAGE_ROOT,
      "..",
      "..",
      "node_modules",
      "fixture",
      "index.js",
    );
    const generatedCompiledFilePath = join(
      EVE_PACKAGE_ROOT,
      ".generated",
      "compiled",
      "gray-matter",
      "index.js",
    );
    const distCompiledFilePath = join(
      EVE_PACKAGE_ROOT,
      "dist",
      "src",
      "compiled",
      "gray-matter",
      "index.js",
    );
    const scriptFilePath = join(EVE_PACKAGE_ROOT, "scripts", "vendor-compiled.mjs");

    filter.onLog(
      "warn",
      {
        loc: {
          file: dependencyFilePath,
        },
        message: "dependency implementation detail",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "warn",
      {
        id: generatedCompiledFilePath,
        message: "generated compiled dependency implementation detail",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "warn",
      {
        loc: {
          file: distCompiledFilePath,
        },
        message: "dist compiled dependency implementation detail",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "warn",
      {
        id: scriptFilePath,
        message: "eve vendoring warning",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "error",
      {
        loc: {
          file: dependencyFilePath,
        },
        message: "dependency build failure",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );

    expect(forwardedLogs).toEqual(["warn:eve vendoring warning", "error:dependency build failure"]);
  });

  it("copies @workflow/core declaration files from the installed package", async () => {
    const [indexDts, createHookDts, workflowDts, workflowIndexDts, runtimeRunDts] =
      await Promise.all([
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/index.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/create-hook.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/workflow.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/workflow/index.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/runtime/run.d.ts"), "utf8"),
      ]);

    expect(indexDts).toContain("Just the core utilities");
    expect(indexDts).toContain("from '#compiled/@workflow/errors/index.js'");
    expect(createHookDts).toContain("Creates a {@link Hook}");
    expect(workflowDts).toBe(`export * from "./workflow/index.js";\n`);
    expect(workflowIndexDts).toContain("from '#compiled/@workflow/errors/index.js'");
    expect(runtimeRunDts).toContain("from '../_workflow-serde.js'");
  });
});
