import { describe, expect, it } from "vitest";

import {
  createCompileMetadata,
  publishCompilerArtifactFiles,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";

describe("compiler artifact publication", () => {
  it("publishes compile metadata after every payload has completed", async () => {
    const paths = resolveCompilerArtifactPaths("/virtual/app");
    const completed: string[] = [];

    await publishCompilerArtifactFiles({
      io: {
        remove: async (path) => {
          completed.push(`remove:${path}`);
        },
        rename: async (from, to) => {
          completed.push(`rename:${from}:${to}`);
        },
        write: async (path) => {
          await Promise.resolve();
          completed.push(`write:${path}`);
        },
      },
      metadataJson: "metadata",
      paths,
      payloads: {
        compiledManifestJson: "manifest",
        diagnosticsArtifactJson: "diagnostics",
        discoveryManifestJson: "discovery",
        moduleMapSource: "module-map",
      },
    });

    const markerRemovalIndex = completed.indexOf(`remove:${paths.compileMetadataPath}`);
    const commitIndex = completed.findIndex(
      (entry) => entry.startsWith("rename:") && entry.endsWith(`:${paths.compileMetadataPath}`),
    );
    expect(markerRemovalIndex).toBeGreaterThanOrEqual(4);
    expect(commitIndex).toBeGreaterThan(markerRemovalIndex);
    expect(completed).not.toContain(`write:${paths.compileMetadataPath}`);
    expect(
      completed
        .slice(0, markerRemovalIndex)
        .filter((entry) =>
          [
            paths.compiledManifestPath,
            paths.diagnosticsPath,
            paths.discoveryManifestPath,
            paths.moduleMapPath,
          ].some((path) => entry.startsWith(`write:${path}.`) && entry.endsWith(".tmp")),
        ),
    ).toHaveLength(4);
    expect(
      completed
        .slice(markerRemovalIndex + 1, commitIndex)
        .filter((entry) =>
          [
            paths.compiledManifestPath,
            paths.diagnosticsPath,
            paths.discoveryManifestPath,
            paths.moduleMapPath,
          ].some((path) => entry.startsWith("rename:") && entry.endsWith(`:${path}`)),
        ),
    ).toHaveLength(4);
  });

  it("preserves the previous committed snapshot when a staged payload write fails", async () => {
    const paths = resolveCompilerArtifactPaths("/virtual/app");
    const files = new Map<string, string>([
      [paths.compileMetadataPath, "old-metadata"],
      [paths.compiledManifestPath, "old-manifest"],
      [paths.diagnosticsPath, "old-diagnostics"],
      [paths.discoveryManifestPath, "old-discovery"],
      [paths.moduleMapPath, "old-module-map"],
    ]);

    await expect(
      publishCompilerArtifactFiles({
        io: {
          remove: async (path) => {
            files.delete(path);
          },
          rename: async (from, to) => {
            files.set(to, files.get(from)!);
            files.delete(from);
          },
          write: async (path, contents) => {
            if (contents === "diagnostics") {
              throw new Error("injected diagnostics write failure");
            }
            files.set(path, contents);
          },
        },
        metadataJson: "metadata",
        paths,
        payloads: {
          compiledManifestJson: "manifest",
          diagnosticsArtifactJson: "diagnostics",
          discoveryManifestJson: "discovery",
          moduleMapSource: "module-map",
        },
      }),
    ).rejects.toThrow("injected diagnostics write failure");

    expect(files).toEqual(
      new Map([
        [paths.compileMetadataPath, "old-metadata"],
        [paths.compiledManifestPath, "old-manifest"],
        [paths.diagnosticsPath, "old-diagnostics"],
        [paths.discoveryManifestPath, "old-discovery"],
        [paths.moduleMapPath, "old-module-map"],
      ]),
    );
    expect([...files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("cleans up an unpublished metadata temporary file when the atomic rename fails", async () => {
    const paths = resolveCompilerArtifactPaths("/virtual/app");
    const visiblePaths = new Set<string>();

    await expect(
      publishCompilerArtifactFiles({
        io: {
          remove: async (path) => {
            visiblePaths.delete(path);
          },
          rename: async (from, to) => {
            if (to === paths.compileMetadataPath) {
              throw new Error("injected metadata rename failure");
            }
            visiblePaths.delete(from);
            visiblePaths.add(to);
          },
          write: async (path) => {
            visiblePaths.add(path);
          },
        },
        metadataJson: "metadata",
        paths,
        payloads: {
          compiledManifestJson: "manifest",
          diagnosticsArtifactJson: "diagnostics",
          discoveryManifestJson: "discovery",
          moduleMapSource: "module-map",
        },
      }),
    ).rejects.toThrow("injected metadata rename failure");

    expect(visiblePaths.has(paths.compileMetadataPath)).toBe(false);
    expect([...visiblePaths].some((path) => path.endsWith(".tmp"))).toBe(false);
  });
});

describe("compiler artifact metadata", () => {
  it("rotates the diagnostics digest and source graph hash for diagnostics-only changes", () => {
    const appRoot = "/tmp/diagnostics-metadata-test";
    const paths = resolveCompilerArtifactPaths(appRoot);
    const createMetadata = (diagnosticsArtifactJson: string) =>
      createCompileMetadata({
        appRoot,
        compiledManifestJson: '{"kind":"eve-agent-compiled-manifest"}\n',
        diagnosticsArtifactJson,
        diagnosticsSummary: { errors: 0, warnings: 1 },
        discoveryManifestJson: '{"kind":"eve-agent-discovery-manifest"}\n',
        moduleMapIdentity: "f".repeat(64),
        moduleMapSource: "export const moduleMap = {};\n",
        paths,
      });
    const first = createMetadata(
      '{"diagnostics":[{"message":"first"}],"kind":"eve-compiler-diagnostics"}\n',
    );
    const second = createMetadata(
      '{"diagnostics":[{"message":"second"}],"kind":"eve-compiler-diagnostics"}\n',
    );

    expect(second.compile).toEqual(first.compile);
    expect(second.discovery.manifest).toEqual(first.discovery.manifest);
    expect(second.discovery.summary).toEqual(first.discovery.summary);
    expect(second.discovery.diagnostics.sha256).not.toBe(first.discovery.diagnostics.sha256);
    expect(second.discovery.sourceGraphHash).not.toBe(first.discovery.sourceGraphHash);
  });
});
