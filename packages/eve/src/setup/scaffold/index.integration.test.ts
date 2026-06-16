import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import {
  deriveSlackConnectorSlug,
  ensureChannel,
  isNextJsProject,
  listAuthoredChannels,
  normalizeSlackConnectorSlug,
  scaffoldBaseProject,
  type WebPackageVersions,
} from "./index.js";
import { PNPM_WORKSPACE_CONTENT } from "../primitives/pm/pnpm.js";
import { WEB_APP_TEMPLATE_FILES } from "./create/web-template.js";
import { pathExists } from "../path-exists.js";

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "eve-scaffold-"));
}

const TEST_EVE_PACKAGE = { version: "0.25.0", nodeEngine: ">=24" } as const;
const LATEST_EVE_PACKAGE = { version: "latest", nodeEngine: ">=24" } as const;

const TEST_WEB_PACKAGE_VERSIONS = {
  evePackage: TEST_EVE_PACKAGE,
  aiPackageVersion: "7.0.0",
  nextPackageVersion: "16.2.6",
  reactPackageVersion: "19.2.6",
  reactDomPackageVersion: "19.2.6",
  streamdownPackageVersion: "2.5.0",
  zodPackageVersion: "4.4.3",
  tsgoPackageVersion: "7.0.0-dev",
  typesReactPackageVersion: "19.2.15",
  typesReactDomPackageVersion: "19.2.3",
} satisfies WebPackageVersions;

describe("normalizeSlackConnectorSlug", () => {
  test("removes npm scope and unsafe connector path characters", () => {
    expect(normalizeSlackConnectorSlug("@acme/My.Agent")).toBe("my-agent");
    expect(normalizeSlackConnectorSlug("@acme/my_agent")).toBe("my_agent");
    expect(normalizeSlackConnectorSlug("///")).toBe("my-agent");
  });
});

describe("ensureChannel", () => {
  test("writes a Slack channel with a sanitized connector slug", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "@scope/My.Agent", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    const slug = await deriveSlackConnectorSlug(projectRoot);
    const result = await ensureChannel({
      projectRoot,
      kind: "slack",
      slackConnectorSlug: slug,
      connectPackageVersion: "0.0.0-test",
    });

    expect(result).toEqual({
      kind: "slack",
      action: "created",
      filesWritten: [join(projectRoot, "agent/channels/slack.ts")],
      filesSkipped: [],
      packageJsonUpdated: [
        {
          path: join(projectRoot, "package.json"),
          dependencies: ["@vercel/connect"],
          devDependencies: [],
          scripts: [],
        },
      ],
      slackConnectorSlug: slug,
    });
    await expect(readFile(join(projectRoot, "agent/channels/slack.ts"), "utf8")).resolves.toContain(
      'connectSlackCredentials("slack/my-agent")',
    );
    await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
      '"@vercel/connect": "0.0.0-test"',
    );
  });

  test("writes the exact Slack connector UID returned by Connect", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(join(projectRoot, "package.json"), "{}\n", "utf8");

    await ensureChannel({
      projectRoot,
      kind: "slack",
      slackConnectorUid: "slack/my-agent-2",
      connectPackageVersion: "0.0.0-test",
    });

    await expect(readFile(join(projectRoot, "agent/channels/slack.ts"), "utf8")).resolves.toContain(
      'connectSlackCredentials("slack/my-agent-2")',
    );
  });

  test("skips an existing Slack channel unless force is set", async () => {
    const projectRoot = await createTempDir();
    const channelPath = join(projectRoot, "agent/channels/slack.ts");
    const packageJsonPath = join(projectRoot, "package.json");
    await mkdir(join(projectRoot, "agent/channels"), { recursive: true });
    await writeFile(packageJsonPath, "{}\n", "utf8");
    await writeFile(channelPath, "existing\n", "utf8");

    const result = await ensureChannel({
      projectRoot,
      kind: "slack",
      connectPackageVersion: "0.0.0-test",
    });

    await expect(readFile(channelPath, "utf8")).resolves.toBe("existing\n");
    await expect(readFile(packageJsonPath, "utf8")).resolves.toBe("{}\n");
    expect(result).toEqual({
      kind: "slack",
      action: "skipped",
      filesWritten: [],
      filesSkipped: [channelPath],
      packageJsonUpdated: [],
    });
  });

  test("writes the Next AI Elements Web Chat app and patches package.json", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent/channels"), { recursive: true });
    await writeFile(join(projectRoot, "agent/channels/eve.ts"), "existing channel\n", "utf8");
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    expect(result.kind).toBe("web");
    expect(result.action).toBe("created");
    expect(result).not.toHaveProperty("nodeEngineOverride");
    expect(result.filesWritten).toContain(join(projectRoot, "app/page.tsx"));
    expect(result.filesWritten).toContain(join(projectRoot, "next.config.ts"));
    expect(result.filesWritten).toContain(join(projectRoot, "pnpm-workspace.yaml"));
    expect(result.filesWritten).toContain(join(projectRoot, "vercel.json"));
    expect(result.filesSkipped).toEqual([join(projectRoot, "agent/channels/eve.ts")]);
    expect(result.packageJsonUpdated).toEqual([
      expect.objectContaining({
        path: join(projectRoot, "package.json"),
        dependencies: expect.arrayContaining(["eve", "next", "react", "react-dom"]),
        devDependencies: expect.arrayContaining(["@typescript/native-preview", "@types/react"]),
        scripts: expect.arrayContaining(["build", "dev", "start", "typecheck"]),
      }),
    ]);
    await expect(readFile(join(projectRoot, "agent/channels/eve.ts"), "utf8")).resolves.toBe(
      "existing channel\n",
    );
    await expect(readFile(join(projectRoot, "app/page.tsx"), "utf8")).resolves.toContain(
      "AgentChat",
    );
    await expect(
      readFile(join(projectRoot, "agent/tools/randomize.ts"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.filesWritten).not.toContain(join(projectRoot, ".gitignore"));
    expect(result.filesWritten).not.toContain(join(projectRoot, "tsconfig.tsbuildinfo"));
    const agentChatSource = await readFile(
      join(projectRoot, "app/_components/agent-chat.tsx"),
      "utf8",
    );
    expect(agentChatSource).toContain("rounded-full transition-colors");
    expect(agentChatSource).not.toContain("rounded - full transition - colors");
    await expect(readFile(join(projectRoot, "next.config.ts"), "utf8")).resolves.toContain(
      "withEve",
    );
    const packageJson = await readFile(join(projectRoot, "package.json"), "utf8");
    expect(packageJson).toContain('"next": "16.2.6"');
    expect(packageJson).toContain('"dev": "next dev"');
    expect(JSON.parse(packageJson)).toMatchObject({ engines: { node: "24.x" } });
    await expect(readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      PNPM_WORKSPACE_CONTENT,
    );
    await expect(readFile(join(projectRoot, "vercel.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          $schema: "https://openapi.vercel.sh/vercel.json",
          experimentalServices: {
            web: {
              entrypoint: ".",
              framework: "nextjs",
              routePrefix: "/",
            },
            eve: {
              buildCommand: "eve build",
              entrypoint: ".",
              framework: "eve",
              routePrefix: "/_eve_internal/eve",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  test("overrides an incompatible node engine when adding Web Chat", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "demo",
          type: "module",
          engines: { node: "22.x", npm: ">=10" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      configureVercelServices: false,
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    expect(result).toMatchObject({
      kind: "web",
      nodeEngineOverride: { previous: "22.x", next: "24.x" },
    });
    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x", npm: ">=10" },
    });
  });

  test("preserves a compatible node engine when adding Web Chat", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "demo",
          type: "module",
          engines: { node: "24.x", npm: ">=10" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      configureVercelServices: false,
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    expect(result).not.toHaveProperty("nodeEngineOverride");
    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x", npm: ">=10" },
    });
  });

  test("scaffolds Web Chat with the source app channel definition", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    const channelSource = await readFile(join(projectRoot, "agent/channels/eve.ts"), "utf8");
    const sourceChannel = await readFile(
      new URL("../../../../../apps/templates/web-chat-next/agent/channels/eve.ts", import.meta.url),
      "utf8",
    );
    // The template is LF; a Windows checkout may hand back the source app as
    // CRLF (no repo .gitattributes), so compare line content, not line endings.
    const normalizeEol = (text: string): string => text.replaceAll("\r\n", "\n");
    expect(normalizeEol(channelSource)).toBe(normalizeEol(sourceChannel));
  });

  test("writes npm dist-tags for Web Chat without semver range decoration", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: {
        ...TEST_WEB_PACKAGE_VERSIONS,
        evePackage: LATEST_EVE_PACKAGE,
      },
    });

    await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
      '"eve": "latest"',
    );
  });

  test("preserves existing Vercel configuration when adding Web Chat services", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(projectRoot, "vercel.json"),
      `${JSON.stringify({ regions: ["iad1"], experimentalServices: { worker: { entrypoint: "worker.ts" } } }, null, 2)}\n`,
      "utf8",
    );

    await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    await expect(
      readFile(join(projectRoot, "vercel.json"), "utf8").then((value) => JSON.parse(value)),
    ).resolves.toMatchObject({
      regions: ["iad1"],
      experimentalServices: {
        worker: { entrypoint: "worker.ts" },
        web: { framework: "nextjs" },
        eve: { framework: "eve" },
      },
    });
  });

  test("scaffolds Web Chat without Vercel Services for preview-only targets", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
      configureVercelServices: false,
    });

    expect(result.filesWritten).not.toContain(join(projectRoot, "vercel.json"));
    await expect(readFile(join(projectRoot, "vercel.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(projectRoot, "next.config.ts"), "utf8")).resolves.toContain(
      "withEve(nextConfig)",
    );
    await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
      '"dev": "next dev"',
    );
  });

  test("reports Next config files that compete with the generated Web Chat config", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(projectRoot, "next.config.mjs"), "export default {};\n", "utf8");

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
      configureVercelServices: false,
    });

    if (result.kind !== "web" || result.action !== "created") {
      throw new Error(`Expected Web Chat to be created, got ${result.kind}:${result.action}`);
    }
    expect(result.filesWritten).toContain(join(projectRoot, "next.config.ts"));
    expect(result.competingNextConfigFiles).toEqual([join(projectRoot, "next.config.mjs")]);
    await expect(readFile(join(projectRoot, "next.config.ts"), "utf8")).resolves.toContain(
      "withEve(nextConfig)",
    );
    await expect(readFile(join(projectRoot, "next.config.mjs"), "utf8")).resolves.toBe(
      "export default {};\n",
    );
  });

  test("adds the Web Chat pnpm build policy to existing workspace policy", async () => {
    const projectRoot = await createTempDir();
    const pnpmWorkspacePath = join(projectRoot, "pnpm-workspace.yaml");
    const existingPolicy = "packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n";
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(pnpmWorkspacePath, existingPolicy, "utf8");

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    await expect(readFile(pnpmWorkspacePath, "utf8")).resolves.toBe(
      "packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n  sharp: false\n\nminimumReleaseAgeExclude:\n  - eve\n",
    );
    expect(result.filesWritten).toContain(pnpmWorkspacePath);
  });

  test("preserves an existing explicit sharp build policy when adding Web Chat", async () => {
    const projectRoot = await createTempDir();
    const pnpmWorkspacePath = join(projectRoot, "pnpm-workspace.yaml");
    const existingPolicy = "allowBuilds:\n  sharp: true\n";
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(pnpmWorkspacePath, existingPolicy, "utf8");

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    await expect(readFile(pnpmWorkspacePath, "utf8")).resolves.toBe(
      `${existingPolicy}\nminimumReleaseAgeExclude:\n  - eve\n`,
    );
    expect(result.filesWritten).toContain(pnpmWorkspacePath);
  });

  test("adds the eve release age exclusion to an existing pnpm workspace exclusion list", async () => {
    const projectRoot = await createTempDir();
    const pnpmWorkspacePath = join(projectRoot, "pnpm-workspace.yaml");
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      pnpmWorkspacePath,
      "minimumReleaseAgeExclude:\n  - react\nallowBuilds:\n  sharp: false\n",
      "utf8",
    );

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    await expect(readFile(pnpmWorkspacePath, "utf8")).resolves.toBe(
      "minimumReleaseAgeExclude:\n  - react\n  - eve\nallowBuilds:\n  sharp: false\n",
    );
    expect(result.filesWritten).toContain(pnpmWorkspacePath);
  });

  test("skips Web Chat when Next.js is already present", async () => {
    const projectRoot = await createTempDir();
    const pagePath = join(projectRoot, "app/page.tsx");
    const packageJsonPath = join(projectRoot, "package.json");
    const existingPackageJson = `${JSON.stringify(
      {
        name: "demo",
        type: "module",
        dependencies: { next: "16.2.6" },
      },
      null,
      2,
    )}\n`;
    await mkdir(join(projectRoot, "app"), { recursive: true });
    await writeFile(pagePath, "existing\n", "utf8");
    await writeFile(packageJsonPath, existingPackageJson, "utf8");

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    await expect(readFile(pagePath, "utf8")).resolves.toBe("existing\n");
    await expect(readFile(packageJsonPath, "utf8")).resolves.toBe(existingPackageJson);
    expect(result).toMatchObject({
      kind: "web",
      action: "skipped",
      skipReason: "nextjs-project",
      filesWritten: [],
      filesSkipped: [packageJsonPath],
      packageJsonUpdated: [],
    });
  });
});

describe("isNextJsProject", () => {
  test("reads as no app when package.json is missing", async () => {
    const projectRoot = await createTempDir();

    await expect(isNextJsProject(projectRoot)).resolves.toBe(false);
  });

  test("finds a next dependency in any dependency field", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "demo", devDependencies: { next: "16.2.6" } }),
      "utf8",
    );

    await expect(isNextJsProject(projectRoot)).resolves.toBe(true);
  });

  test("ignores a project without a next dependency", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { eve: "0.25.0" } }),
      "utf8",
    );

    await expect(isNextJsProject(projectRoot)).resolves.toBe(false);
  });
});

describe("listAuthoredChannels", () => {
  test("recognizes flat channel modules and folder connection modules", async () => {
    const projectRoot = await createTempDir();
    await mkdir(join(projectRoot, "agent/channels/slack"), { recursive: true });
    await writeFile(join(projectRoot, "agent/channels/slack/connection.ts"), "", "utf8");
    await writeFile(join(projectRoot, "agent/channels/email.mts"), "", "utf8");

    await expect(listAuthoredChannels(projectRoot)).resolves.toEqual(["email", "slack"]);
  });
});

describe("scaffoldBaseProject", () => {
  test("writes a base eve project with explicit versions", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      connectPackageVersion: "0.2.2",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    const agentSource = await readFile(join(projectRoot, "agent/agent.ts"), "utf8");
    expect(agentSource).toContain('model: "openai/gpt-5-mini"');
    expect(agentSource).not.toContain("modelOptions");
    const packageJson = await readFile(join(projectRoot, "package.json"), "utf8");
    expect(packageJson).toContain('"eve": "^0.25.0"');
    // Channels added later (`eve channels add slack`, possibly next to a
    // running `eve dev`) import @vercel/connect; init ships it so a later
    // channel add never introduces a missing dependency.
    expect(packageJson).toContain('"@vercel/connect": "0.2.2"');
    // Every scaffold ships @types/node plus tsconfig `types: ["node"]` so agent
    // code touching `process`/`fs` typechecks out of the box, matching the eve
    // agent fixtures (without the `types` entry, NodeNext resolution does not
    // auto-include the ambient node types under pnpm's symlinked layout).
    expect(packageJson).toContain('"@types/node": "24.x"');
    const tsconfig = JSON.parse(await readFile(join(projectRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { types?: string[] };
    };
    expect(tsconfig.compilerOptions.types).toEqual(["node"]);
    // Pinned to a single major so Vercel builds on a supported Node regardless
    // of the project's dashboard Node pin.
    expect(JSON.parse(packageJson)).toMatchObject({ engines: { node: "24.x" } });
    await expect(readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      PNPM_WORKSPACE_CONTENT,
    );
    await expect(readFile(join(projectRoot, "AGENTS.md"), "utf8")).resolves.toContain(
      "node_modules/eve/docs/",
    );
    // `vercel deploy` uploads everything a .vercelignore doesn't exclude, and
    // the platform default-ignores only the .env.local variants — eve's dev
    // artifacts and a bare .env must be excluded here or a source deploy
    // ships them (and `.eve` alone can blow the upload size limit).
    const vercelignore = await readFile(join(projectRoot, ".vercelignore"), "utf8");
    for (const entry of [".env*", ".eve", ".workflow-data", ".output", ".nitro", "dist"]) {
      expect(vercelignore.split("\n")).toContain(entry);
    }
  });

  test.each(["npm", "yarn", "bun"] as const)(
    "omits the pnpm workspace policy from a scaffold owned by %s",
    async (packageManager) => {
      const targetDirectory = await createTempDir();
      const projectRoot = await scaffoldBaseProject({
        projectName: "demo-agent",
        model: "openai/gpt-5-mini",
        packageManager,
        targetDirectory,
        evePackage: TEST_EVE_PACKAGE,
        aiPackageVersion: "7.0.0",
        zodPackageVersion: "4.4.3",
        tsgoPackageVersion: "7.0.0-dev",
      });

      await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
        '"eve": "^0.25.0"',
      );
      await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
    },
  );

  test("writes a byok provider agent and adds @types/node", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "anthropic/claude-opus-4.8",
      byokProvider: true,
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    const agentSource = await readFile(join(projectRoot, "agent/agent.ts"), "utf8");
    expect(agentSource).toContain('model: "anthropic/claude-opus-4.8"');
    expect(agentSource).toContain("modelOptions");
    expect(agentSource).toContain("byok");
    expect(agentSource).toContain('"anthropic": [{ apiKey: process.env.ANTHROPIC_API_KEY! }]');

    const packageJson = await readFile(join(projectRoot, "package.json"), "utf8");
    expect(packageJson).toContain('"@types/node": "24.x"');
  });

  test("derives the byok provider block from the model's provider prefix", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      byokProvider: true,
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    const agentSource = await readFile(join(projectRoot, "agent/agent.ts"), "utf8");
    expect(agentSource).toContain('model: "openai/gpt-5-mini"');
    expect(agentSource).toContain('"openai": [{ apiKey: process.env.OPENAI_API_KEY! }]');
  });

  test("derives @types/node from the selected Node engine major", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "anthropic/claude-opus-4.8",
      byokProvider: true,
      targetDirectory,
      evePackage: { version: "0.25.0", nodeEngine: ">=24.5.0" },
      aiPackageVersion: "7.0.0",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
      engines: { node: string };
    };
    expect(packageJson.devDependencies["@types/node"]).toBe("25.x");
    expect(packageJson.engines.node).toBe("25.x");
  });

  test("writes npm dist-tags without semver range decoration", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      targetDirectory,
      evePackage: LATEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
      '"eve": "latest"',
    );
  });

  test("scaffolds the default eve channel from the Web Chat channel template", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    const channelPath = join(projectRoot, "agent/channels/eve.ts");
    const channelSource = await readFile(channelPath, "utf8");

    expect(channelSource).toBe(WEB_APP_TEMPLATE_FILES["agent/channels/eve.ts"]);
  });

  test("overwrites existing in-place scaffold files only when explicitly allowed", async () => {
    const targetDirectory = await createTempDir();
    const overwritten: string[] = [];
    await mkdir(join(targetDirectory, "agent"), { recursive: true });
    await writeFile(join(targetDirectory, "package.json"), "{}\n", "utf8");
    await writeFile(join(targetDirectory, "agent/agent.ts"), "old agent\n", "utf8");

    await expect(
      scaffoldBaseProject({
        projectName: ".",
        model: "openai/gpt-5-mini",
        targetDirectory,
        evePackage: TEST_EVE_PACKAGE,
        aiPackageVersion: "7.0.0",
        zodPackageVersion: "4.4.3",
        tsgoPackageVersion: "7.0.0-dev",
      }),
    ).rejects.toThrow(/Use an empty directory/);

    const projectRoot = await scaffoldBaseProject({
      projectName: ".",
      model: "openai/gpt-5-mini",
      targetDirectory,
      overwriteExisting: true,
      onOverwriteFile: (filePath) => {
        overwritten.push(filePath);
      },
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      zodPackageVersion: "4.4.3",
      tsgoPackageVersion: "7.0.0-dev",
    });

    expect(projectRoot).toBe(targetDirectory);
    // The scaffolder reports template paths as `${targetRoot}/${relPath}` with
    // forward slashes on every platform; `join` would expect backslashes on
    // Windows and fail there.
    expect(overwritten).toEqual([
      `${targetDirectory}/agent/agent.ts`,
      `${targetDirectory}/package.json`,
    ]);
    await expect(readFile(join(targetDirectory, "agent/agent.ts"), "utf8")).resolves.toContain(
      'model: "openai/gpt-5-mini"',
    );
  });
});
