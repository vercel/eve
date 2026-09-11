import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";

let agentRoot: string;

beforeEach(() => {
  agentRoot = mkdtempSync(join(tmpdir(), "eve-instrumentation-layout-"));
});

function writeInstrumentationFile(extension = ".ts"): string {
  const path = join(agentRoot, `instrumentation${extension}`);
  writeFileSync(path, "export default {};\n");
  return path;
}

function writeInstrumentationProvider(fileName: string): string {
  const directory = join(agentRoot, "instrumentation");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, "export default {};\n");
  return path;
}

describe("resolveInstrumentationLayout with providers off", () => {
  it("returns nothing when the agent authored no instrumentation", () => {
    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toBeUndefined();
  });

  it("resolves the single instrumentation file", () => {
    const modulePath = writeInstrumentationFile();

    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toEqual({
      kind: "file",
      modulePath,
    });
  });

  it.each([[".mts"], [".js"], [".mjs"]])("resolves a %s instrumentation file", (extension) => {
    const modulePath = writeInstrumentationFile(extension);

    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toEqual({
      kind: "file",
      modulePath,
    });
  });

  it("ignores a providers directory", () => {
    writeInstrumentationProvider("otel.ts");

    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toBeUndefined();
  });
});

describe("resolveInstrumentationLayout with providers on", () => {
  it("returns an empty directory layout for eve's built-in destinations", () => {
    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toEqual({
      kind: "directory",
      modulePathsBySlot: {},
    });
  });

  it("derives sorted provider slots across module extensions and ignores non-module files", () => {
    const otel = writeInstrumentationProvider("otel.ts");
    const agentRuns = writeInstrumentationProvider("agent-runs.ts");
    const local = writeInstrumentationProvider("local.mts");
    writeInstrumentationProvider("README.md");

    const layout = resolveInstrumentationLayout({ agentRoot, providersEnabled: true });

    expect(layout).toEqual({
      kind: "directory",
      modulePathsBySlot: { "agent-runs": agentRuns, local, otel },
    });
    expect(Object.keys(layout?.kind === "directory" ? layout.modulePathsBySlot : {})).toEqual([
      "agent-runs",
      "local",
      "otel",
    ]);
  });

  it("rejects two files claiming one slot", () => {
    writeInstrumentationProvider("otel.ts");
    writeInstrumentationProvider("otel.js");

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toThrow(
      /Two files declare the "otel" instrumentation provider/,
    );
  });

  it("rejects a single instrumentation file, naming the flag", () => {
    writeInstrumentationFile();

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toThrow(
      /experimental\.instrumentationProviders/,
    );
  });

  it("prefers the file error when both layouts are present", () => {
    writeInstrumentationFile();
    writeInstrumentationProvider("otel.ts");

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toThrow(
      /Move it into the "instrumentation\/" directory/,
    );
  });
});
