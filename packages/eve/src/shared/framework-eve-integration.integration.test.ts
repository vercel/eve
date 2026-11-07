import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { addEveVercelServices } from "./framework-eve-integration.js";

const createTemporaryDirectory = useTemporaryDirectories();

const host = { label: "Vite", slug: "vite" };
const agents = [{ appRoot: "/app", publicRoutePrefix: "" }];

const never = async (): Promise<never> => {
  throw new Error("generated services for a project that declares them");
};

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }),
  );
}

function vercelServices(services: readonly (readonly [name: string, framework: string])[]): string {
  return JSON.stringify({
    services: Object.fromEntries(
      services.map(([name, framework]) => [name, { framework, root: "." }]),
    ),
  });
}

describe("addEveVercelServices", () => {
  it("leaves the services to a vercel.json that includes the eve service", async () => {
    const root = await createTemporaryDirectory("eve-framework-integration-");
    await writeFiles(root, {
      "vercel.json": vercelServices([
        ["web", "vite"],
        ["eve", "eve"],
      ]),
    });

    await expect(
      addEveVercelServices(never, {
        agents,
        eveBuildCommand: undefined,
        host,
        hostRoot: root,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a vercel.json whose services omit the eve service", async () => {
    const root = await createTemporaryDirectory("eve-framework-integration-");
    await writeFiles(root, { "vercel.json": vercelServices([["web", "vite"]]) });

    await expect(
      addEveVercelServices(never, {
        agents,
        eveBuildCommand: undefined,
        host,
        hostRoot: root,
      }),
    ).rejects.toThrow(/already defines services/);
  });

  it("leaves the services to a vercel.ts that composes withEve", async () => {
    const root = await createTemporaryDirectory("eve-framework-integration-");
    await writeFiles(root, {
      "vercel.ts": 'import { withEve } from "eve/vercel";\n\nexport default await withEve({});\n',
    });

    await expect(
      addEveVercelServices(never, {
        agents,
        eveBuildCommand: undefined,
        host,
        hostRoot: root,
      }),
    ).resolves.toBeUndefined();
  });

  it("reads vercel.json from a linked Vercel project root", async () => {
    const projectRoot = await createTemporaryDirectory("eve-framework-integration-");
    const hostRoot = join(projectRoot, "apps", "web");
    await writeFiles(projectRoot, {
      ".vercel/project.json": "{}\n",
      "vercel.json": vercelServices([
        ["web", "vite"],
        ["eve", "eve"],
      ]),
    });
    await mkdir(hostRoot, { recursive: true });

    await expect(
      addEveVercelServices(never, {
        agents,
        eveBuildCommand: undefined,
        host,
        hostRoot,
      }),
    ).resolves.toBeUndefined();
  });

  it("prefers the host root vercel.json over the linked project's", async () => {
    const projectRoot = await createTemporaryDirectory("eve-framework-integration-");
    const hostRoot = join(projectRoot, "apps", "web");
    await writeFiles(projectRoot, {
      ".vercel/project.json": "{}\n",
      "vercel.json": vercelServices([
        ["web", "vite"],
        ["eve", "eve"],
      ]),
    });
    await writeFiles(hostRoot, { "vercel.json": vercelServices([["web", "vite"]]) });

    await expect(
      addEveVercelServices(never, {
        agents,
        eveBuildCommand: undefined,
        host,
        hostRoot,
      }),
    ).rejects.toThrow(/already defines services/);
  });
});
