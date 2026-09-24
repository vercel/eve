import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createConnectManifest } from "#internal/external-resources.js";
import { createExternalResourcesSnapshot } from "#internal/external-resources-snapshot.js";

async function createAppWithCompiler(source: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-connect-compiler-"));
  const packageRoot = join(appRoot, "node_modules", "@vercel", "connect");
  await mkdir(join(packageRoot, "dist", "manifest"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      exports: { "./manifest": "./dist/manifest/index.js" },
      name: "@vercel/connect",
      type: "module",
    }),
  );
  await writeFile(join(packageRoot, "dist", "manifest", "index.js"), source);
  return appRoot;
}

const snapshot = createExternalResourcesSnapshot({
  generatorVersion: "1.2.3",
  resources: [
    {
      credentials: {
        reference: "connector:linear/my-agent",
        service: "linear",
        subjectTypes: ["user"],
      },
      kind: "connection",
      logicalPath: "connections/linear.ts",
      name: "linear",
      protocol: { type: "mcp", url: "https://mcp.linear.app/mcp" },
    },
  ],
});

describe("Connect manifest compiler handoff", () => {
  it("returns compiler JSON", async () => {
    const appRoot = await createAppWithCompiler(
      "export function experimental_createConnectManifestFromEveResources() { return { ok: true }; }\n",
    );

    await expect(createConnectManifest({ appRoot, snapshot })).resolves.toEqual({ ok: true });
  });

  it("surfaces compiler failures with recovery guidance", async () => {
    const appRoot = await createAppWithCompiler(
      'export function experimental_createConnectManifestFromEveResources() { throw new Error("unsupported snapshot"); }\n',
    );

    await expect(createConnectManifest({ appRoot, snapshot })).rejects.toThrow(
      "Failed to create the Connect manifest: unsupported snapshot. Update @vercel/connect and rerun `eve build`.",
    );
  });

  it("rejects a package without the compiler export", async () => {
    const appRoot = await createAppWithCompiler("export {};\n");

    await expect(createConnectManifest({ appRoot, snapshot })).rejects.toThrow(
      /missing experimental_createConnectManifestFromEveResources export/,
    );
  });

  it("skips compiler resolution when there are no resources", async () => {
    const empty = createExternalResourcesSnapshot({ generatorVersion: "1.2.3", resources: [] });

    await expect(
      createConnectManifest({ appRoot: "/missing", snapshot: empty }),
    ).resolves.toBeUndefined();
  });
});
