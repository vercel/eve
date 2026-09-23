import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";

let agentRoot: string;

beforeEach(() => {
  agentRoot = mkdtempSync(join(tmpdir(), "eve-instrumentation-layout-"));
});

function writeInstrumentationFile(extension = ".ts"): void {
  writeFileSync(join(agentRoot, `instrumentation${extension}`), "export default {};\n");
}

function writeInstrumentationProvider(fileName: string): string {
  const directory = join(agentRoot, "instrumentation");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, "export default {};\n");
  return path;
}

describe("resolveInstrumentationLayout", () => {
  it("returns an empty directory layout for eve's built-in destinations", () => {
    expect(resolveInstrumentationLayout({ agentRoot })).toEqual({
      kind: "directory",
      modulePathsBySlot: {},
    });
  });

  it("keys files by path-derived slot in stable order", () => {
    const otel = writeInstrumentationProvider("otel.ts");
    const local = writeInstrumentationProvider("local.mts");
    const audit = writeInstrumentationProvider("audit.mjs");

    expect(resolveInstrumentationLayout({ agentRoot })).toEqual({
      kind: "directory",
      modulePathsBySlot: { audit, local, otel },
    });
  });

  it("ignores files that are not instrumentation modules", () => {
    const otel = writeInstrumentationProvider("otel.ts");
    writeInstrumentationProvider("README.md");

    expect(resolveInstrumentationLayout({ agentRoot }).modulePathsBySlot).toEqual({ otel });
  });

  it("rejects two files claiming one slot", () => {
    writeInstrumentationProvider("otel.ts");
    writeInstrumentationProvider("otel.js");

    expect(() => resolveInstrumentationLayout({ agentRoot })).toThrow(
      /Two files declare the "otel" instrumentation provider/,
    );
  });

  it.each([".ts", ".mts", ".js", ".mjs"])(
    "rejects the removed single-file layout for %s",
    (extension) => {
      writeInstrumentationFile(extension);

      expect(() => resolveInstrumentationLayout({ agentRoot })).toThrow(
        /Move it into the "instrumentation\/" directory/,
      );
    },
  );
});
