import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  deriveSlackConnectorSlug,
  ensureChannel,
  type WebPackageVersions,
} from "#setup/scaffold/index.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import type { AddChannelsDeps } from "#setup/boxes/add-channels.js";
import type { DeployProjectDeps } from "#setup/boxes/deploy-project.js";
import { createFakePrompter, type FakePrompterConfig } from "#internal/testing/fake-prompter.js";

import { runChannelsAddCommand, type CliLogger } from "./channels.js";

class TestLogger implements CliLogger {
  readonly errors: string[] = [];
  readonly logs: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

async function createAgentProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "eve-channels-command-"));
  await mkdir(join(projectRoot, "agent"), { recursive: true });
  await writeFile(join(projectRoot, "agent/agent.ts"), "export default {};\n", "utf8");
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "@scope/My.Agent", dependencies: {} }, null, 2)}\n`,
    "utf8",
  );
  return projectRoot;
}

async function withInteractiveTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    return await fn();
  } finally {
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    }
    if (stdoutDescriptor !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }
  }
}

function sourceImportSpecifier(relativePath: string): string {
  return new URL(relativePath, import.meta.url).href;
}

const TEST_WEB_PACKAGE_VERSIONS = {
  evePackage: { version: "0.32.0", nodeEngine: ">=24" },
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

const UNLINKED: DeploymentInfo = { state: "unlinked" };

const DEPLOYED: DeploymentInfo = {
  state: "deployed",
  projectId: "prj_demo",
  productionUrl: "https://agent.vercel.app",
};

/**
 * Fakes for the add-channels box effects, with the REAL slug derivation so the
 * package.json-name fallback ("@scope/My.Agent" -> "my-agent") stays pinned.
 */
function createAddChannelsDeps(boxDetectDeployment: DeploymentInfo = UNLINKED) {
  return {
    ensureChannel: vi.fn<AddChannelsDeps["ensureChannel"]>(async (options) =>
      options.kind === "web"
        ? {
            kind: "web",
            action: "created",
            filesWritten: [join(options.projectRoot, "app/page.tsx")],
            filesSkipped: [],
            packageJsonUpdated: [],
          }
        : {
            kind: "slack",
            action: "created",
            filesWritten: [join(options.projectRoot, "agent/channels/slack.ts")],
            filesSkipped: [],
            packageJsonUpdated: [],
            slackConnectorSlug:
              options.slackConnectorSlug ?? (await deriveSlackConnectorSlug(options.projectRoot)),
          },
    ),
    deriveSlackConnectorSlug,
    provisionSlackbot: vi.fn<AddChannelsDeps["provisionSlackbot"]>(async () => ({
      state: "attached",
      connectorUid: "slack/my-agent",
    })),
    reconcileSlackUid: vi.fn<AddChannelsDeps["reconcileSlackUid"]>(async () => true),
    detectPackageManager: vi.fn<AddChannelsDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<AddChannelsDeps["runPackageManagerInstall"]>(async () => true),
    runVercel: vi.fn<AddChannelsDeps["runVercel"]>(async () => true),
    detectDeployment: vi.fn<AddChannelsDeps["detectDeployment"]>(async () => boxDetectDeployment),
  };
}

function createDeployProjectDeps(probe: DeploymentInfo = DEPLOYED) {
  return {
    runVercel: vi.fn<DeployProjectDeps["runVercel"]>(async () => true),
    detectPackageManager: vi.fn<DeployProjectDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<DeployProjectDeps["runPackageManagerInstall"]>(
      async () => true,
    ),
    detectDeployment: vi.fn<DeployProjectDeps["detectDeployment"]>(async () => probe),
  };
}

function createTestPrompter(config: FakePrompterConfig = {}) {
  return createFakePrompter(config);
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runChannelsAddCommand", () => {
  test("refuses a directory without an eve agent using the shared init guidance", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-channels-empty-"));
    const logger = new TestLogger();

    await runChannelsAddCommand(logger, projectRoot, { kind: "web", options: {} });

    expect(logger.errors).toEqual([
      "No eve agent in this directory. Run `eve init <name>`, then run this command from inside the new project.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("seeds the boxes from current Vercel deployment status and deploys after Slack", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const fake = createTestPrompter({ single: () => "yes" });
    const addChannelsDeps = createAddChannelsDeps();
    const deployProjectDeps = createDeployProjectDeps();

    await runChannelsAddCommand(
      logger,
      projectRoot,
      { kind: "slack", options: { force: true } },
      {
        createPrompter: () => fake.prompter,
        detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => DEPLOYED),
        addChannelsDeps,
        deployProjectDeps,
      },
    );

    // The seeded resolution makes the link fallback unnecessary.
    expect(addChannelsDeps.runVercel).not.toHaveBeenCalled();
    expect(addChannelsDeps.provisionSlackbot).toHaveBeenCalledWith(
      expect.anything(),
      projectRoot,
      // agentName stays "" in this command, so the slug derives from the
      // package.json name, never the directory basename (R6).
      "my-agent",
    );
    expect(addChannelsDeps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "slack", slackConnectorSlug: "my-agent", force: true }),
    );
    // Slack armed a pending deployment; the deploy box ran it interactively.
    expect(deployProjectDeps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(fake.prompter.outro).toHaveBeenCalledWith("Channels added.");
    expect(logger.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("auto-confirms slackbot creation when --yes is set", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    // No select handler: any prompt would throw, proving --yes skipped the
    // slackbot question.
    const fake = createTestPrompter();
    const addChannelsDeps = createAddChannelsDeps({ state: "linked", projectId: "prj_demo" });

    await runChannelsAddCommand(
      logger,
      projectRoot,
      { kind: "slack", options: { yes: true } },
      {
        createPrompter: () => fake.prompter,
        detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => UNLINKED),
        addChannelsDeps,
        deployProjectDeps: createDeployProjectDeps(),
      },
    );

    expect(fake.selectMessages).toEqual([]);
    expect(addChannelsDeps.provisionSlackbot).toHaveBeenCalledOnce();
    expect(logger.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("links an unlinked directory with a bare interactive `vercel link` before the slackbot", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const fake = createTestPrompter({ single: () => "yes" });
    const addChannelsDeps = createAddChannelsDeps({ state: "linked", projectId: "prj_demo" });
    const deployProjectDeps = createDeployProjectDeps();

    await runChannelsAddCommand(
      logger,
      projectRoot,
      { kind: "slack", options: {} },
      {
        createPrompter: () => fake.prompter,
        detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => UNLINKED),
        addChannelsDeps,
        deployProjectDeps,
      },
    );

    // The engine's exact link fallback: a bare interactive `vercel link` with
    // NO onOutput (it must own the terminal), then slackbot provisioning.
    expect(addChannelsDeps.runVercel).toHaveBeenCalledExactlyOnceWith(["link"], {
      cwd: projectRoot,
    });
    expect(addChannelsDeps.runVercel.mock.invocationCallOrder[0]).toBeLessThan(
      addChannelsDeps.provisionSlackbot.mock.invocationCallOrder[0]!,
    );
    expect(addChannelsDeps.provisionSlackbot).toHaveBeenCalledOnce();
    // Slack is never gated on a pre-linked project in this command.
    expect(logger.errors).toEqual([]);
    expect(fake.prompter.outro).toHaveBeenCalledWith("Channels added.");
    expect(process.exitCode).toBeUndefined();
  });

  test("requires an explicit channel kind when --yes is set on a TTY", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const detectDeployment = vi.fn(async (): Promise<DeploymentInfo> => UNLINKED);

    await withInteractiveTerminal(() =>
      runChannelsAddCommand(logger, projectRoot, { options: { yes: true } }, { detectDeployment }),
    );

    expect(detectDeployment).not.toHaveBeenCalled();
    expect(logger.errors).toEqual(["Pass a channel kind: `eve channels add <slack|web>`."]);
    expect(process.exitCode).toBe(1);
  });

  test("dispatches Web channel scaffolding through the CLI command", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const previousCwd = process.cwd();
    // Run the REAL web scaffold. The command itself passes no versions (the
    // build-stamped defaults own them in production); the source tree carries
    // unstamped tokens, so the test injects stamped versions at the deps seam
    // after asserting the command left both decisions to the box.
    const ensureChannelWithTestVersions: AddChannelsDeps["ensureChannel"] = async (options) => {
      expect(options.webPackageVersions).toBeUndefined();
      expect(options.configureVercelServices).toBe(true);
      return ensureChannel({ ...options, webPackageVersions: TEST_WEB_PACKAGE_VERSIONS });
    };
    const addChannelsDeps = {
      ...createAddChannelsDeps(),
      ensureChannel: vi.fn(ensureChannelWithTestVersions),
    };
    const deployProjectDeps = createDeployProjectDeps();
    const fake = createTestPrompter();

    process.chdir(projectRoot);
    try {
      await runChannelsAddCommand(
        logger,
        projectRoot,
        { kind: "web", options: {} },
        {
          createPrompter: () => fake.prompter,
          detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => UNLINKED),
          addChannelsDeps,
          deployProjectDeps,
        },
      );
    } finally {
      process.chdir(previousCwd);
    }

    await expect(readFile(join(projectRoot, "app/page.tsx"), "utf8")).resolves.toContain(
      "AgentChat",
    );
    const nextConfig = await readFile(join(projectRoot, "next.config.ts"), "utf8");
    expect(nextConfig).toContain("export default withEve(nextConfig);");
    // configureVercelServices stays pinned on for this command (R5): the
    // scaffold writes the services config even in an unlinked directory.
    await expect(readFile(join(projectRoot, "vercel.json"), "utf8")).resolves.toContain(
      "experimentalServices",
    );
    await expect(readFile(join(projectRoot, "agent/channels/web.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.not.toContain(
      "@vercel/connect",
    );
    // Unlinked and web-only: the command opts the deploy box into the
    // interactive link fallback, so it links (without onOutput, the #1020
    // deadlock guard) and deploys instead of silently skipping.
    expect(deployProjectDeps.runVercel).toHaveBeenCalledWith(["link"], {
      cwd: projectRoot,
    });
    expect(deployProjectDeps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(fake.prompter.outro).toHaveBeenCalledWith("Channels added.");
    expect(logger.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("does not scaffold Web Chat over an existing eve session channel", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const authModulePath = sourceImportSpecifier("../../public/channels/auth.ts");
    const eveChannelModulePath = sourceImportSpecifier("../../public/channels/eve.ts");
    await mkdir(join(projectRoot, "agent/channels"), { recursive: true });
    await writeFile(
      join(projectRoot, "agent/channels/custom.ts"),
      [
        `import { none } from ${JSON.stringify(authModulePath)};`,
        `import { eveChannel } from ${JSON.stringify(eveChannelModulePath)};`,
        "",
        "export default eveChannel({ auth: none() });",
        "",
      ].join("\n"),
      "utf8",
    );
    const fake = createTestPrompter();

    await runChannelsAddCommand(
      logger,
      projectRoot,
      { kind: "web", options: {} },
      {
        createPrompter: () => fake.prompter,
        detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => UNLINKED),
      },
    );

    await expect(readFile(join(projectRoot, "agent/channels/web.ts"), "utf8")).rejects.toThrow();
    expect(logger.errors).toEqual([
      "Cannot scaffold Web Chat because agent/channels/custom.ts already defines POST /eve/v1/session. Web Chat scaffolds the same eve session routes.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("does not scaffold Slack over an existing authored Slack channel", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const slackChannelModulePath = sourceImportSpecifier(
      "../../public/channels/slack/slackChannel.ts",
    );
    await mkdir(join(projectRoot, "agent/channels"), { recursive: true });
    await writeFile(
      join(projectRoot, "agent/channels/operations.ts"),
      [
        `import { slackChannel } from ${JSON.stringify(slackChannelModulePath)};`,
        "",
        'export default slackChannel({ connector: "slack/team-bot" });',
        "",
      ].join("\n"),
      "utf8",
    );
    // No select handler: the conflict rejection happens before the slackbot
    // question, so any prompt would throw.
    const fake = createTestPrompter();
    const addChannelsDeps = createAddChannelsDeps();

    await runChannelsAddCommand(
      logger,
      projectRoot,
      { kind: "slack", options: {} },
      {
        createPrompter: () => fake.prompter,
        detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => UNLINKED),
        addChannelsDeps,
      },
    );

    await expect(readFile(join(projectRoot, "agent/channels/slack.ts"), "utf8")).rejects.toThrow();
    expect(addChannelsDeps.provisionSlackbot).not.toHaveBeenCalled();
    expect(logger.errors).toEqual([
      "Cannot scaffold Slack because agent/channels/operations.ts already defines a Slack channel. Slack scaffolding would register the channel again.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("passes existing channel registrations into the channel picker", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const authModulePath = sourceImportSpecifier("../../public/channels/auth.ts");
    const eveChannelModulePath = sourceImportSpecifier("../../public/channels/eve.ts");
    const slackChannelModulePath = sourceImportSpecifier(
      "../../public/channels/slack/slackChannel.ts",
    );
    await mkdir(join(projectRoot, "agent/channels"), { recursive: true });
    await writeFile(
      join(projectRoot, "agent/channels/browser.ts"),
      [
        `import { none } from ${JSON.stringify(authModulePath)};`,
        `import { eveChannel } from ${JSON.stringify(eveChannelModulePath)};`,
        "",
        "export default eveChannel({ auth: none() });",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "agent/channels/operations.ts"),
      [
        `import { slackChannel } from ${JSON.stringify(slackChannelModulePath)};`,
        "",
        'export default slackChannel({ connector: "slack/team-bot" });',
        "",
      ].join("\n"),
      "utf8",
    );
    let pickerOptions: ReadonlyArray<{
      value: string | number | boolean;
      disabled?: boolean;
      disabledReason?: string;
    }> = [];
    let pickerRequired: boolean | undefined;
    const fake = createTestPrompter({
      multiple: (opts) => {
        pickerOptions = opts.options;
        pickerRequired = opts.required;
        return [];
      },
    });
    const addChannelsDeps = createAddChannelsDeps();
    const deployProjectDeps = createDeployProjectDeps();

    await withInteractiveTerminal(() =>
      runChannelsAddCommand(
        logger,
        projectRoot,
        { options: {} },
        {
          createPrompter: () => fake.prompter,
          detectDeployment: vi.fn(async (): Promise<DeploymentInfo> => UNLINKED),
          addChannelsDeps,
          deployProjectDeps,
        },
      ),
    );

    expect(pickerOptions).toEqual([
      expect.objectContaining({
        value: "web",
        disabled: true,
        disabledReason: "POST /eve/v1/session already registered",
      }),
      expect.objectContaining({
        value: "slack",
        disabled: true,
        disabledReason: "Slack channel already registered",
      }),
    ]);
    // The channels-add picker has no locked Terminal UI row and allows an empty
    // submission, which lands on the "No channels added." outro.
    expect(pickerRequired).toBe(false);
    expect(addChannelsDeps.ensureChannel).not.toHaveBeenCalled();
    expect(deployProjectDeps.runVercel).not.toHaveBeenCalled();
    expect(fake.prompter.outro).toHaveBeenCalledWith("No channels added.");
    expect(logger.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
