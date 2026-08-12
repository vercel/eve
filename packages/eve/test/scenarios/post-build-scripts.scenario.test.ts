import { execFile } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const runFile = promisify(execFile);
const createScratchDirectory = useTemporaryDirectories();
const testDirectory = dirname(fileURLToPath(import.meta.url));

async function copyPackageScript(packageRoot: string, fileName: string): Promise<void> {
  await writeFile(
    join(packageRoot, "scripts", fileName),
    await readFile(join(testDirectory, "..", "..", "scripts", fileName), "utf8"),
    "utf8",
  );
}

async function copyRootScript(repoRoot: string, fileName: string): Promise<void> {
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await writeFile(
    join(repoRoot, "scripts", fileName),
    await readFile(join(testDirectory, "..", "..", "..", "..", "scripts", fileName), "utf8"),
    "utf8",
  );
}

async function createPostBuildFixture(
  input: {
    readonly packageReadme?: string;
  } = {},
): Promise<string> {
  const repoRoot = await createScratchDirectory("eve-post-build-scripts-");
  const packageRoot = join(repoRoot, "packages", "eve");

  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, "dist", "src", "chunks"), { recursive: true });
  await mkdir(join(packageRoot, "dist", "src", "cli", "commands"), { recursive: true });
  await mkdir(join(packageRoot, "dist", "src", "internal", "application"), {
    recursive: true,
  });
  await mkdir(join(repoRoot, "docs"), { recursive: true });

  await copyPackageScript(packageRoot, "copy-docs.mjs");
  await copyPackageScript(packageRoot, "stamp-version-tokens.mjs");
  await writeFile(join(repoRoot, "README.md"), "# Monorepo README\n", "utf8");
  await writeFile(join(repoRoot, "docs", "guide.md"), "doc\n", "utf8");
  await writeFile(
    join(packageRoot, "package.json"),
    '{"version":"1.2.3","engines":{"node":">=24"}}\n',
    "utf8",
  );
  await writeFile(
    join(repoRoot, "pnpm-workspace.yaml"),
    [
      "catalog:",
      '  ai: "2.0.0"',
      '  next: "16.2.6"',
      '  react: "19.2.6"',
      '  react-dom: "19.2.6"',
      '  streamdown: "2.5.0"',
      '  "@vercel/connect": "3.0.0"',
      '  "@types/react": "19.2.15"',
      '  "@types/react-dom": "19.2.3"',
      '  zod: "4.0.0"',
      '  typescript: "5.0.0"',
      "",
    ].join("\n"),
    "utf8",
  );

  if (input.packageReadme !== undefined) {
    await writeFile(join(packageRoot, "README.md"), input.packageReadme, "utf8");
  }

  return packageRoot;
}

describe("post-build scripts", () => {
  it("copies docs without overwriting the package README", async () => {
    const packageReadme = "# Package README\nKeep me as-is.\n";
    const packageRoot = await createPostBuildFixture({ packageReadme });
    await mkdir(join(packageRoot, "dist", "docs"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "docs", "guide.md"), "stale\n", "utf8");

    await runFile(process.execPath, [join(packageRoot, "scripts", "copy-docs.mjs")], {
      cwd: packageRoot,
    });

    await expect(readFile(join(packageRoot, "docs", "guide.md"), "utf8")).resolves.toBe("doc\n");
    await expect(access(join(packageRoot, "dist", "docs"), constants.F_OK)).rejects.toThrow();
    await expect(readFile(join(packageRoot, "README.md"), "utf8")).resolves.toBe(packageReadme);
  });

  it("does not synthesize a package README when copying docs", async () => {
    const packageRoot = await createPostBuildFixture();

    await runFile(process.execPath, [join(packageRoot, "scripts", "copy-docs.mjs")], {
      cwd: packageRoot,
    });

    await expect(access(join(packageRoot, "README.md"), constants.F_OK)).rejects.toThrow();
  });

  it("prepares a canary package with separate runtime and scaffold dependency versions", async () => {
    const packageRoot = await createPostBuildFixture();
    const repoRoot = join(packageRoot, "..", "..");
    const sha = "a".repeat(40);
    await copyRootScript(repoRoot, "prepare-canary-package.mjs");
    await writeFile(
      join(packageRoot, "dist", "src", "internal", "application", "package.js"),
      'export const version = "__EVE_PACKAGE_VERSION__";\n',
      "utf8",
    );
    await writeFile(
      join(packageRoot, "dist", "src", "chunks", "scaffold-abc123.js"),
      'export const dependency = "__EVE_PACKAGE_DEPENDENCY_VERSION__";\n',
      "utf8",
    );

    await runFile(process.execPath, [join(repoRoot, "scripts", "prepare-canary-package.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, EVE_CANARY_SHA: sha },
    });

    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({ version: `1.2.4-canary.${sha}` });

    const dependencyUrl = `https://canary.eve.dev/canary/${sha}/eve.tgz`;
    await runFile(process.execPath, [join(packageRoot, "scripts", "stamp-version-tokens.mjs")], {
      cwd: packageRoot,
      env: { ...process.env, EVE_CANARY_DEPENDENCY_URL: dependencyUrl },
    });

    await expect(
      readFile(join(packageRoot, "dist", "src", "internal", "application", "package.js"), "utf8"),
    ).resolves.toBe(`export const version = "1.2.4-canary.${sha}";\n`);
    await expect(
      readFile(join(packageRoot, "dist", "src", "chunks", "scaffold-abc123.js"), "utf8"),
    ).resolves.toBe(`export const dependency = "${dependencyUrl}";\n`);
  });

  it("stamps version tokens across bundled package and scaffold chunks", async () => {
    const packageRoot = await createPostBuildFixture();
    await writeFile(
      join(packageRoot, "dist", "src", "internal", "application", "package.js"),
      'export const version = "__EVE_PACKAGE_VERSION__";\n',
      "utf8",
    );
    await writeFile(
      join(packageRoot, "dist", "src", "cli", "commands", "channels.js"),
      'export const connect = "__VERCEL_CONNECT_VERSION__";\n',
      "utf8",
    );
    await writeFile(
      join(packageRoot, "dist", "src", "chunks", "scaffold-abc123.js"),
      [
        'export const dependency = "__EVE_PACKAGE_DEPENDENCY_VERSION__";',
        'export const ai = "__AI_SDK_VERSION__";',
        'export const next = "__NEXT_VERSION__";',
        'export const react = "__REACT_VERSION__";',
        'export const reactDom = "__REACT_DOM_VERSION__";',
        'export const streamdown = "__STREAMDOWN_VERSION__";',
        'export const nodeEngine = "__NODE_ENGINE__";',
        'export const typesReact = "__TYPES_REACT_VERSION__";',
        'export const typesReactDom = "__TYPES_REACT_DOM_VERSION__";',
        'export const zod = "__ZOD_VERSION__";',
        'export const typescript = "__TYPESCRIPT_VERSION__";',
        "",
      ].join("\n"),
      "utf8",
    );

    await runFile(process.execPath, [join(packageRoot, "scripts", "stamp-version-tokens.mjs")], {
      cwd: packageRoot,
    });

    await expect(
      readFile(join(packageRoot, "dist", "src", "internal", "application", "package.js"), "utf8"),
    ).resolves.toBe('export const version = "1.2.3";\n');
    await expect(
      readFile(join(packageRoot, "dist", "src", "cli", "commands", "channels.js"), "utf8"),
    ).resolves.toBe('export const connect = "3.0.0";\n');
    await expect(
      readFile(join(packageRoot, "dist", "src", "chunks", "scaffold-abc123.js"), "utf8"),
    ).resolves.toBe(
      [
        'export const dependency = "1.2.3";',
        'export const ai = "2.0.0";',
        'export const next = "16.2.6";',
        'export const react = "19.2.6";',
        'export const reactDom = "19.2.6";',
        'export const streamdown = "2.5.0";',
        'export const nodeEngine = ">=24";',
        'export const typesReact = "19.2.15";',
        'export const typesReactDom = "19.2.3";',
        'export const zod = "4.0.0";',
        'export const typescript = "5.0.0";',
        "",
      ].join("\n"),
    );
  });
});
