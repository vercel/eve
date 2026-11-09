import { describe, expect, it } from "vitest";

import {
  BUILD_DEPLOYMENT_ID_PLACEHOLDER,
  computeBuildDeploymentId,
  replaceBuildDeploymentId,
} from "./build-deployment-id.js";

const file = (relativePath: string, content: string) => ({
  relativePath,
  bytes: Buffer.from(content),
});

function idOf(
  files: readonly { relativePath: string; bytes: Uint8Array }[],
  extras?: readonly string[],
): Promise<string> {
  const bytes = new Map(files.map((entry) => [entry.relativePath, entry.bytes]));
  return computeBuildDeploymentId(
    files.map((entry) => entry.relativePath),
    async (relativePath) => bytes.get(relativePath)!,
    extras,
  );
}

describe("build deployment identity", () => {
  it("hashes sorted paths, bytes, and environment inputs, excluding only root tooling metadata", async () => {
    const files = [file("server/index.mjs", "run();"), file(".eve/instructions.md", "Help Alice.")];
    const extras = ["eve@1.0.0", "world@1.0.0"];
    const id = await idOf(files, extras);
    expect(id).toMatch(/^eve_[a-f0-9]{32}$/);
    expect(await idOf([...files].reverse(), [...extras].reverse())).toBe(id);
    expect(await idOf([...files, file("nitro.json", "volatile")], extras)).toBe(id);
    for (const changed of [
      [file("server/index.mjs", "run(1);"), files[1]!],
      [file("server/other.mjs", "run();"), files[1]!],
      [...files, file("server/nitro.json", "runtime input")],
      [files[0]!],
    ])
      expect(await idOf(changed, extras)).not.toBe(id);
    expect(await idOf(files, ["eve@1.0.1", extras[1]!])).not.toBe(id);
    expect(await idOf([file("ab", "c")])).not.toBe(await idOf([file("a", "bc")]));
  });

  it("bounds reads in flight and surfaces the first read failure", async () => {
    const paths = Array.from(
      { length: 40 },
      (_, index) => `server/${String(index).padStart(2, "0")}`,
    );
    let inFlight = 0;
    let maxInFlight = 0;
    await computeBuildDeploymentId(paths, async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return new Uint8Array();
    });
    expect(maxInFlight).toBeLessThanOrEqual(16);
    await expect(
      computeBuildDeploymentId(paths, async (path) => {
        throw new Error(`unreadable ${path}`);
      }),
    ).rejects.toThrow("unreadable server/00");
  });

  it("patches exactly one placeholder without changing offsets or the original bytes", async () => {
    const original = file("server/chunk.mjs", `before:${BUILD_DEPLOYMENT_ID_PLACEHOLDER}:after`);
    const id = await idOf([original]);
    const patched = replaceBuildDeploymentId([original], id);
    expect(patched.relativePath).toBe(original.relativePath);
    expect(Buffer.from(patched.bytes).toString()).toBe(`before:${id}:after`);
    expect(patched.bytes.length).toBe(original.bytes.length);
    expect(original.bytes.toString()).toContain(BUILD_DEPLOYMENT_ID_PLACEHOLDER);
    for (const files of [
      [],
      [file("server/a.mjs", "missing")],
      [original, file("server/b.mjs", BUILD_DEPLOYMENT_ID_PLACEHOLDER)],
      [file("server/a.mjs", BUILD_DEPLOYMENT_ID_PLACEHOLDER.repeat(2))],
    ]) {
      expect(() => replaceBuildDeploymentId(files, id)).toThrow(
        "expected exactly one workflow-world placeholder",
      );
    }
    expect(() => replaceBuildDeploymentId([original], "latest")).toThrow(
      "Invalid build deployment id",
    );
  });
});
