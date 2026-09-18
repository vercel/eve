import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createConnectManifest } from "#internal/external-resources.js";
import { createExternalResourcesSnapshot } from "#internal/external-resources-snapshot.js";

async function createAppWithConverter(source: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-connect-compiler-"));
  const packageRoot = join(appRoot, "node_modules", "@vercel", "connect");
  await mkdir(join(packageRoot, "dist", "eve"), { recursive: true });
  await mkdir(join(packageRoot, "dist", "internal"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "eve", "index.js"), "export {};\n");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      bin: { "vercel-connect-manifest": "./dist/internal/manifest-cli.js" },
      exports: { "./eve": "./dist/eve/index.js" },
      name: "@vercel/connect",
      type: "module",
    }),
  );
  const executable = join(packageRoot, "dist", "internal", "manifest-cli.js");
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return appRoot;
}

const snapshot = createExternalResourcesSnapshot({
  generatorVersion: "1.2.3",
  resources: [
    {
      connection: { type: "mcp", url: "https://mcp.linear.app/mcp" },
      credentials: {
        method: "oauth",
        reference: "connector:linear/my-agent",
        service: "linear",
        subjectTypes: ["user"],
      },
      kind: "connection",
      logicalPath: "connections/linear.ts",
      name: "linear",
    },
  ],
});

describe("Connect manifest compiler handoff", () => {
  it("returns converter JSON", async () => {
    const appRoot = await createAppWithConverter(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{\\"ok\\":true}"));\n',
    );

    await expect(createConnectManifest({ appRoot, snapshot })).resolves.toEqual({ ok: true });
  });

  it("surfaces converter failures with recovery guidance", async () => {
    const appRoot = await createAppWithConverter(
      'process.stderr.write("unsupported snapshot"); process.exitCode = 1;\n',
    );

    await expect(createConnectManifest({ appRoot, snapshot })).rejects.toThrow(
      "Failed to create the Connect manifest: unsupported snapshot. Update @vercel/connect and rerun `eve build`.",
    );
  });

  it("recovers when the converter exits while a large snapshot is being written", async () => {
    const appRoot = await createAppWithConverter("process.exitCode = 1;\n");
    const largeSnapshot = {
      ...snapshot,
      resources: Array.from({ length: 10_000 }, () => snapshot.resources[0]!),
    };

    await expect(createConnectManifest({ appRoot, snapshot: largeSnapshot })).rejects.toThrow(
      /Update @vercel\/connect and rerun `eve build`/,
    );
  });

  it("skips converter resolution when there are no resources", async () => {
    const empty = createExternalResourcesSnapshot({ generatorVersion: "1.2.3", resources: [] });

    await expect(
      createConnectManifest({ appRoot: "/missing", snapshot: empty }),
    ).resolves.toBeUndefined();
  });
});
