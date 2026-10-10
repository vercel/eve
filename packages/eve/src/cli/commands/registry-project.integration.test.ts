import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parse as parseJsonc } from "#compiled/jsonc-parser/index.js";

import {
  prepareWebChatProjectRoot,
  prepareWebRegistryProject,
  readRegistryConfig,
} from "./registry-project.js";

describe("readRegistryConfig", () => {
  it("reads registry mappings from an agent workspace package", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-workspace-"));
    const agentRoot = join(workspaceRoot, "agents", "support");
    await mkdir(join(agentRoot, "agent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        dependencies: { eve: "*" },
        registries: { "@acme": "https://example.com/r/{name}.json" },
      }),
    );

    await expect(readRegistryConfig(agentRoot)).resolves.toEqual({
      registries: { "@acme": "https://example.com/r/{name}.json" },
    });
  });
});

describe("prepareWebRegistryProject", () => {
  it("leaves a fresh app for the registry transaction to create", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-web-project-"));
    const tsconfigPath = join(workspaceRoot, "apps", "web", "tsconfig.json");

    await prepareWebRegistryProject(workspaceRoot);

    await expect(readFile(tsconfigPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges the TanStack Start tsconfig into an existing app without Next.js config", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-web-project-"));
    const tsconfigPath = join(workspaceRoot, "apps", "web", "tsconfig.json");
    await mkdir(join(workspaceRoot, "apps", "web"), { recursive: true });
    await writeFile(
      tsconfigPath,
      '{\n  // Authored settings.\n  "compilerOptions": { "strict": false, "types": ["node"] },\n}\n',
    );

    await prepareWebRegistryProject(workspaceRoot, "tanstack");

    const source = await readFile(tsconfigPath, "utf8");
    expect(source).toContain("// Authored settings.");
    expect(parseJsonc(source)).toEqual({
      compilerOptions: {
        strict: false,
        types: ["node", "vite/client"],
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        paths: { "@/*": ["./*"] },
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules", ".output", ".vercel"],
    });
  });
});

describe("prepareWebChatProjectRoot", () => {
  async function createProjectRoot(scripts: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eve-registry-web-scripts-"));
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { eve: "*" }, scripts }),
    );
    return root;
  }

  async function readScripts(root: string): Promise<Record<string, string>> {
    return (
      JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
  }

  it("adds Next.js web scripts by default", async () => {
    const root = await createProjectRoot({});

    await prepareWebChatProjectRoot(root);

    await expect(readScripts(root)).resolves.toEqual({
      "build:web": "next build apps/web",
      "dev:web": "next dev apps/web",
    });
  });

  it("adds Vite web scripts for TanStack Start and keeps authored scripts", async () => {
    const root = await createProjectRoot({ "dev:web": "custom" });

    await prepareWebChatProjectRoot(root, "tanstack");

    await expect(readScripts(root)).resolves.toEqual({
      "build:web": "vite build apps/web",
      "dev:web": "custom",
    });
  });

  it("replaces Next.js installer scripts when switching to TanStack Start", async () => {
    const root = await createProjectRoot({
      "build:web": "next build apps/web",
      "dev:web": "next dev apps/web",
    });

    await prepareWebChatProjectRoot(root, "tanstack");

    await expect(readScripts(root)).resolves.toEqual({
      "build:web": "vite build apps/web",
      "dev:web": "vite dev apps/web",
    });
  });

  it("replaces TanStack Start installer scripts when switching to Next.js", async () => {
    const root = await createProjectRoot({
      "build:web": "vite build apps/web",
      "dev:web": "vite dev apps/web",
    });

    await prepareWebChatProjectRoot(root, "next");

    await expect(readScripts(root)).resolves.toEqual({
      "build:web": "next build apps/web",
      "dev:web": "next dev apps/web",
    });
  });
});
