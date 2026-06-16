import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Self-tests for the unit-guard setup file. These assertions confirm that the
 * guard is active when this file is loaded and that legitimate read-only
 * operations remain available.
 */

describe("unit-guard", () => {
  it("blocks fs/promises write operations", async () => {
    await expect(fsPromises.writeFile("/tmp/eve-unit-guard-probe", "")).rejects.toThrow(
      /Unit tests may not invoke/,
    );
    await expect(fsPromises.mkdtemp("/tmp/eve-unit-guard-probe-")).rejects.toThrow(
      /Unit tests may not invoke/,
    );
    await expect(
      fsPromises.mkdir("/tmp/eve-unit-guard-probe", { recursive: true }),
    ).rejects.toThrow(/Unit tests may not invoke/);
  });

  it("blocks synchronous fs write operations", () => {
    expect(() => fs.writeFileSync("/tmp/eve-unit-guard-probe", "")).toThrow(
      /Unit tests may not invoke/,
    );
    expect(() => fs.mkdirSync("/tmp/eve-unit-guard-probe")).toThrow(/Unit tests may not invoke/);
  });

  it("blocks child_process operations", () => {
    expect(() => childProcess.spawn("echo", ["hi"])).toThrow(/Unit tests may not invoke/);
    expect(() => childProcess.execSync("echo hi")).toThrow(/Unit tests may not invoke/);
  });

  it("blocks process.chdir", () => {
    expect(() => process.chdir("/tmp")).toThrow(/Unit tests may not invoke/);
  });

  it("blocks real network fetch", async () => {
    await expect(fetch("https://example.com/does-not-exist")).rejects.toThrow(
      /Unit tests may not make real network requests/,
    );
  });

  it("allows fs reads so setup helpers and package metadata loaders still work", async () => {
    const contents = await fsPromises.readFile(new URL("./unit-guard.ts", import.meta.url), "utf8");
    expect(contents.length).toBeGreaterThan(0);
  });
});
