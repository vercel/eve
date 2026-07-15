import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import {
  deriveSlackConnectorSlug,
  ensureChannel,
  hasVercelHostFramework,
  isNextJsProject,
  listAuthoredChannels,
  normalizeSlackConnectorSlug,
  scaffoldBaseProject,
  scaffoldExtensionProject,
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
const RELEASE_AGE_POLICY =
  'minimumReleaseAgeExclude:\n  - "@ai-sdk/*"\n  - "@rolldown/*"\n  - "@vercel/*"\n  - "@workflow/*"\n  - ai\n  - experimental-ai-sdk-code-mode\n  - eve\n  - nitro\n  - rolldown\n  - workflow\n';

const TEST_WEB_PACKAGE_VERSIONS = {
  evePackage: TEST_EVE_PACKAGE,
  aiPackageVersion: "7.0.0",
  nextPackageVersion: "16.2.6",
  reactPackageVersion: "19.2.6",
  reactDomPackageVersion: "19.2.6",
  streamdownPackageVersion: "2.5.0",
  zodPackageVersion: "4.4.3",
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
        devDependencies: expect.arrayContaining(["typescript", "@types/react"]),
        scripts: expect.arrayContaining([
          "build",
          "build:eve",
          "dev",
          "dev:eve",
          "start",
          "start:eve",
          "typecheck",
        ]),
      }),
    ]);
    await expect(readFile(join(projectRoot, "agent/channels/eve.ts"), "utf8")).resolves.toBe(
      "existing channel\n",
    );
    const patchedPackageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(patchedPackageJson.devDependencies.typescript).toBe("6.0.3");
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
    expect(packageJson).toContain('"build:eve": "eve build"');
    expect(packageJson).toContain('"dev": "next dev"');
    expect(packageJson).toContain('"dev:eve": "eve dev"');
    expect(packageJson).toContain('"start:eve": "eve start"');
    expect(JSON.parse(packageJson)).toMatchObject({ engines: { node: "24.x" } });
    const tsconfig = JSON.parse(await readFile(join(projectRoot, "tsconfig.json"), "utf8")) as {
      include?: string[];
    };
    expect(tsconfig.include).not.toContain(".eve/**/*.d.ts");
    await expect(readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      PNPM_WORKSPACE_CONTENT,
    );
    // withEve() generates the eve service + /eve/v1/* routes into
    // .vercel/output/config.json at build time, so the scaffold only writes a
    // minimal vercel.json rather than a services block the platform rejects.
    await expect(readFile(join(projectRoot, "vercel.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          $schema: "https://openapi.vercel.sh/vercel.json",
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

  test("preserves existing Vercel configuration when adding Web Chat", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    const existingVercelJson = `${JSON.stringify({ regions: ["iad1"], rewrites: [] }, null, 2)}\n`;
    await writeFile(join(projectRoot, "vercel.json"), existingVercelJson, "utf8");

    await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });

    // withEve() owns eve service generation, so the scaffold leaves an existing
    // vercel.json completely untouched — no injected services block, no $schema
    // rewrite, no reformatting of a file the user manages.
    await expect(readFile(join(projectRoot, "vercel.json"), "utf8")).resolves.toBe(
      existingVercelJson,
    );
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
      `packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n  sharp: false\n\n${RELEASE_AGE_POLICY}`,
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
      `${existingPolicy}\n${RELEASE_AGE_POLICY}`,
    );
    expect(result.filesWritten).toContain(pnpmWorkspacePath);
  });

  test("adds the release age exclusions to an existing pnpm workspace exclusion list", async () => {
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
      'minimumReleaseAgeExclude:\n  - react\n  - "@ai-sdk/*"\n  - "@rolldown/*"\n  - "@vercel/*"\n  - "@workflow/*"\n  - ai\n  - experimental-ai-sdk-code-mode\n  - eve\n  - nitro\n  - rolldown\n  - workflow\nallowBuilds:\n  sharp: false\n',
    );
    expect(result.filesWritten).toContain(pnpmWorkspacePath);
  });

  test("adds Web Chat pnpm policy and a missing package pattern at the ancestor workspace root", async () => {
    const workspaceRoot = await createTempDir();
    const projectRoot = join(workspaceRoot, "agents", "agent");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "agent", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    const result = await ensureChannel({
      projectRoot,
      kind: "web",
      webPackageVersions: TEST_WEB_PACKAGE_VERSIONS,
    });
    if (result.kind !== "web" || result.action === "skipped") {
      throw new Error(`Expected Web Chat to be created, got ${result.kind}:${result.action}`);
    }

    expect(result.filesWritten).toContain(join(workspaceRoot, "pnpm-workspace.yaml"));
    expect(result.filesWritten).not.toContain(join(projectRoot, "pnpm-workspace.yaml"));
    await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      `packages:\n  - apps/*\n  - agents/*\n\nallowBuilds:\n  sharp: false\n\n${RELEASE_AGE_POLICY}`,
    );
    const projectPackageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { engines?: unknown; dependencies: Record<string, string> };
    expect(projectPackageJson.dependencies.eve).toBe("^0.25.0");
    expect(projectPackageJson.engines).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
    expect(result.nodeEngineOverride).toEqual({
      kind: "overridden",
      next: "24.x",
      previous: "22.x",
    });
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

  test("finds a next dependency in the Vercel framework dependency fields", async () => {
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

describe("hasVercelHostFramework", () => {
  test("reads as no host app when package.json is missing", async () => {
    const projectRoot = await createTempDir();

    await expect(hasVercelHostFramework(projectRoot)).resolves.toBe(false);
  });

  test.each([
    ["Next.js", { next: "16.2.6" }],
    ["Nuxt", { nuxt: "4.3.3" }],
    ["Nuxt 3", { nuxt3: "3.19.7" }],
    ["Nuxt edge", { "nuxt-edge": "3.0.0-rc.13" }],
    ["Nuxt nightly", { "nuxt-nightly": "3.0.0-27575307.749db41" }],
    ["SvelteKit", { "@sveltejs/kit": "2.60.0" }],
  ])("recognizes %s as the root Vercel framework", async (_label, dependencies) => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "demo", devDependencies: dependencies }),
      "utf8",
    );

    await expect(hasVercelHostFramework(projectRoot)).resolves.toBe(true);
  });

  test("does not infer a host framework from ancestor node_modules alone", async () => {
    const workspaceRoot = await createTempDir();
    const projectRoot = join(workspaceRoot, "apps", "agent");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "agent" }), "utf8");
    await mkdir(join(workspaceRoot, "node_modules", "next"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "node_modules", "next", "package.json"),
      JSON.stringify({ name: "next", version: "16.2.6" }),
      "utf8",
    );

    await expect(hasVercelHostFramework(projectRoot)).resolves.toBe(false);
  });

  test("ignores dependency fields Vercel framework detection does not inspect", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        name: "demo",
        optionalDependencies: { next: "16.2.6" },
        peerDependencies: { nuxt: "4.3.3" },
      }),
      "utf8",
    );

    await expect(hasVercelHostFramework(projectRoot)).resolves.toBe(false);
  });

  test("does not scan unrelated sibling package manifests", async () => {
    const workspaceRoot = await createTempDir();
    const projectRoot = join(workspaceRoot, "apps", "agent");
    const siblingRoot = join(workspaceRoot, "apps", "web");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(siblingRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "agent" }), "utf8");
    await writeFile(
      join(siblingRoot, "package.json"),
      JSON.stringify({ name: "web", dependencies: { next: "16.2.6" } }),
      "utf8",
    );

    await expect(hasVercelHostFramework(projectRoot)).resolves.toBe(false);
  });

  test("ignores standalone eve projects", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { eve: "0.25.0" } }),
      "utf8",
    );

    await expect(hasVercelHostFramework(projectRoot)).resolves.toBe(false);
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

describe("scaffoldExtensionProject", () => {
  test("writes a minimal extension package with peer+dev eve and no sample tools", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldExtensionProject({
      projectName: "demo-extension",
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      zodPackageVersion: "4.4.3",
    });

    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      name: string;
      eve?: { extension?: string };
      files?: string[];
      peerDependencies?: { eve?: string };
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      engines?: { node?: string };
    };
    expect(packageJson).toMatchObject({
      name: "demo-extension",
      eve: { extension: "./extension" },
      files: ["extension", "dist"],
      peerDependencies: { eve: "^0.25.0" },
      dependencies: { zod: "4.4.3" },
      scripts: {
        build: "eve extension build",
        prepare: "eve extension build",
        typecheck: "tsc",
      },
      engines: { node: "24.x" },
    });
    expect(packageJson.devDependencies?.eve).toBe("^0.25.0");
    expect(packageJson.devDependencies?.typescript).toBe("7.0.2");
    expect(packageJson.dependencies?.ai).toBeUndefined();
    expect(packageJson.scripts?.dev).toBeUndefined();

    const extensionSource = await readFile(join(projectRoot, "extension/extension.ts"), "utf8");
    expect(extensionSource).toContain('from "eve/extension"');
    expect(extensionSource).toContain("defineExtension");
    expect(extensionSource).toContain("apiKey");
    await expect(pathExists(join(projectRoot, "extension/tools"))).resolves.toBe(false);
    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(false);

    const tsconfig = JSON.parse(await readFile(join(projectRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { moduleResolution?: string; types?: string[] };
      include?: string[];
    };
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.compilerOptions.types).toEqual(["node"]);
    expect(tsconfig.include).toEqual(["extension/**/*.ts"]);

    const agentsMd = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("eve extension");
    expect(agentsMd).toContain("extensions.md");
    expect(agentsMd).toContain("cannot declare");
  });
});

describe("scaffoldBaseProject", () => {
  test("writes a base eve project with the catalog TypeScript version", async () => {
    const targetDirectory = await createTempDir();
    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      connectPackageVersion: "0.2.2",
      zodPackageVersion: "4.4.3",
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
    // The default path used by `eve init` must carry the stable toolchain
    // version captured from the workspace catalog into generated projects.
    expect(JSON.parse(packageJson)).toMatchObject({
      devDependencies: { typescript: "7.0.2" },
      engines: { node: "24.x" },
    });
    // Every scaffold ships @types/node plus tsconfig `types: ["node"]` so agent
    // code touching `process`/`fs` typechecks out of the box, matching the eve
    // agent fixtures (without the `types` entry, NodeNext resolution does not
    // auto-include the ambient node types under pnpm's symlinked layout).
    expect(packageJson).toContain('"@types/node": "24.x"');
    const tsconfig = JSON.parse(await readFile(join(projectRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { types?: string[] };
      include?: string[];
    };
    expect(tsconfig.compilerOptions.types).toEqual(["node"]);
    expect(tsconfig.include).toEqual(["agent/**/*.ts", "evals/**/*.ts"]);
    await expect(readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      PNPM_WORKSPACE_CONTENT,
    );
    const agentsMd = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("installed eve package docs");
    expect(agentsMd).toContain("node_modules/eve/docs/");
    expect(agentsMd).toContain("resolve the\ninstalled `eve` package location");
    // `vercel deploy` uploads everything a .vercelignore doesn't exclude, and
    // the platform default-ignores only the .env.local variants — eve's dev
    // artifacts and a bare .env must be excluded here or a source deploy
    // ships them (and `.eve` alone can blow the upload size limit).
    const vercelignore = await readFile(join(projectRoot, ".vercelignore"), "utf8");
    for (const entry of [".env*", ".eve", ".output", ".nitro", "dist"]) {
      expect(vercelignore.split("\n")).toContain(entry);
    }
  });

  test.each([
    ["pnpm", undefined],
    ["npm", "overrides"],
    ["yarn", "resolutions"],
    ["bun", "overrides"],
  ] as const)(
    "scaffolds a standalone %s project with its own package-manager metadata",
    async (packageManager, aiPinField) => {
      const targetDirectory = await createTempDir();
      const projectRoot = await scaffoldBaseProject({
        projectName: "demo-agent",
        model: "openai/gpt-5-mini",
        packageManager,
        targetDirectory,
        evePackage: TEST_EVE_PACKAGE,
        aiPackageVersion: "7.0.0",
        zodPackageVersion: "4.4.3",
        typescriptPackageVersion: "7.0.2",
      });

      await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
        '"eve": "^0.25.0"',
      );
      await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(
        packageManager === "pnpm",
      );
      const packageJson: unknown = JSON.parse(
        await readFile(join(projectRoot, "package.json"), "utf8"),
      );
      if (aiPinField === undefined) {
        expect(packageJson).not.toHaveProperty("overrides");
        expect(packageJson).not.toHaveProperty("resolutions");
      } else {
        expect(packageJson).toHaveProperty(`${aiPinField}.ai`, "7.0.0");
        expect(packageJson).not.toHaveProperty(
          aiPinField === "overrides" ? "resolutions" : "overrides",
        );
      }
    },
  );

  test("scaffolds a pnpm workspace member without nested root-only package files", async () => {
    const workspaceRoot = await createTempDir();
    const targetDirectory = join(workspaceRoot, "apps");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");

    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      connectPackageVersion: "0.2.2",
      zodPackageVersion: "4.4.3",
      typescriptPackageVersion: "7.0.2",
    });

    await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      `packages:\n  - apps/*\n\nallowBuilds:\n  sharp: false\n\n${RELEASE_AGE_POLICY}`,
    );
    const projectPackageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      engines?: unknown;
      overrides?: unknown;
      resolutions?: unknown;
    };
    expect(projectPackageJson.dependencies.eve).toBe("^0.25.0");
    expect(projectPackageJson.engines).toBeUndefined();
    expect(projectPackageJson.overrides).toBeUndefined();
    expect(projectPackageJson.resolutions).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
  });

  test("scaffolds under an unclaimed pnpm workspace directory by adding a package pattern", async () => {
    const workspaceRoot = await createTempDir();
    const targetDirectory = join(workspaceRoot, "agents");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");

    const projectRoot = await scaffoldBaseProject({
      projectName: "demo-agent",
      model: "openai/gpt-5-mini",
      targetDirectory,
      evePackage: TEST_EVE_PACKAGE,
      aiPackageVersion: "7.0.0",
      connectPackageVersion: "0.2.2",
      zodPackageVersion: "4.4.3",
      typescriptPackageVersion: "7.0.2",
    });

    await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      `packages:\n  - apps/*\n  - agents/*\n\nallowBuilds:\n  sharp: false\n\n${RELEASE_AGE_POLICY}`,
    );
    const projectPackageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      engines?: unknown;
      overrides?: unknown;
      resolutions?: unknown;
    };
    expect(projectPackageJson.engines).toBeUndefined();
    expect(projectPackageJson.overrides).toBeUndefined();
    expect(projectPackageJson.resolutions).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
  });

  test.each([
    ["npm", "overrides"],
    ["bun", "overrides"],
    ["yarn", "resolutions"],
  ] as const)(
    "scaffolds a %s workspace member with root-only package fields at the workspace root",
    async (packageManager, rootAiPinField) => {
      const workspaceRoot = await createTempDir();
      const targetDirectory = join(workspaceRoot, "apps");
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            engines: { node: "22.x" },
            workspaces: ["apps/*"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const projectRoot = await scaffoldBaseProject({
        projectName: "demo-agent",
        model: "openai/gpt-5-mini",
        packageManager,
        targetDirectory,
        evePackage: TEST_EVE_PACKAGE,
        aiPackageVersion: "7.0.0",
        connectPackageVersion: "0.2.2",
        zodPackageVersion: "4.4.3",
        typescriptPackageVersion: "7.0.2",
      });

      const projectPackageJson = JSON.parse(
        await readFile(join(projectRoot, "package.json"), "utf8"),
      ) as {
        engines?: unknown;
        overrides?: unknown;
        resolutions?: unknown;
      };
      expect(projectPackageJson.engines).toBeUndefined();
      expect(projectPackageJson.overrides).toBeUndefined();
      expect(projectPackageJson.resolutions).toBeUndefined();
      const rootPackageJson = JSON.parse(
        await readFile(join(workspaceRoot, "package.json"), "utf8"),
      ) as {
        engines?: { node?: string };
        overrides?: { ai?: string };
        resolutions?: { ai?: string };
      };
      expect(rootPackageJson.engines?.node).toBe("24.x");
      expect(rootPackageJson[rootAiPinField]?.ai).toBe("7.0.0");
    },
  );

  test.each([
    ["npm", "overrides"],
    ["bun", "overrides"],
    ["yarn", "resolutions"],
  ] as const)(
    "scaffolds under an unclaimed %s workspace directory by adding a package pattern",
    async (packageManager, rootAiPinField) => {
      const workspaceRoot = await createTempDir();
      const targetDirectory = join(workspaceRoot, "agents");
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            engines: { node: "22.x" },
            workspaces: ["apps/*"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const projectRoot = await scaffoldBaseProject({
        projectName: "demo-agent",
        model: "openai/gpt-5-mini",
        packageManager,
        targetDirectory,
        evePackage: TEST_EVE_PACKAGE,
        aiPackageVersion: "7.0.0",
        connectPackageVersion: "0.2.2",
        zodPackageVersion: "4.4.3",
        typescriptPackageVersion: "7.0.2",
      });

      const projectPackageJson = JSON.parse(
        await readFile(join(projectRoot, "package.json"), "utf8"),
      ) as {
        engines?: unknown;
        overrides?: unknown;
        resolutions?: unknown;
      };
      expect(projectPackageJson.engines).toBeUndefined();
      expect(projectPackageJson.overrides).toBeUndefined();
      expect(projectPackageJson.resolutions).toBeUndefined();
      const rootPackageJson = JSON.parse(
        await readFile(join(workspaceRoot, "package.json"), "utf8"),
      ) as {
        engines?: { node?: string };
        overrides?: { ai?: string };
        resolutions?: { ai?: string };
        workspaces?: string[];
      };
      expect(rootPackageJson.workspaces).toEqual(["apps/*", "agents/*"]);
      expect(rootPackageJson.engines?.node).toBe("24.x");
      expect(rootPackageJson[rootAiPinField]?.ai).toBe("7.0.0");
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
      typescriptPackageVersion: "7.0.2",
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
      typescriptPackageVersion: "7.0.2",
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
      typescriptPackageVersion: "7.0.2",
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
      typescriptPackageVersion: "7.0.2",
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
      typescriptPackageVersion: "7.0.2",
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
        typescriptPackageVersion: "7.0.2",
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
      typescriptPackageVersion: "7.0.2",
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
