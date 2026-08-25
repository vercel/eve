import { describe, expect, it } from "vitest";

import {
  BOOT_DETECTIONS,
  CLI_MISSING_SETUP_ISSUE,
  detectSetupIssues,
  formatSetupIssuesLine,
  LOGIN_SETUP_ISSUE,
  orderedSetupIssues,
  normalizeLocalModelEndpoint,
  type BootDetectionContext,
} from "./setup-issues.js";

function context(overrides: Partial<BootDetectionContext> = {}): BootDetectionContext {
  return { appRoot: "/nonexistent", env: {}, ...overrides };
}

type AgentInfo = NonNullable<BootDetectionContext["info"]>;
type StaticAgentInfoModel = Extract<AgentInfo["agent"]["model"], { readonly id: string }>;

/** A minimal but fully-typed `/eve/v1/info` payload carrying an endpoint status. */
function infoWithEndpoint(endpoint?: StaticAgentInfoModel["endpoint"]): AgentInfo {
  const model: AgentInfo["agent"]["model"] =
    endpoint === undefined
      ? { id: "m", routing: { kind: "static" } }
      : { endpoint, id: "m", routing: { kind: "static" } };

  return {
    agent: {
      agentRoot: "/a",
      appRoot: "/a",
      config: { source: { logicalPath: "agent.ts", owner: "application", sourceId: "agent.ts" } },
      model,
      name: "Agent",
      nodeId: "__root__",
    },
    capabilities: { devRoutes: true },
    channels: { routes: [], shadowed: [], total: 0 },
    composition: { disabled: [], shadowed: [] },
    connections: [],
    diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
    hooks: [],
    instructions: { dynamicResolvers: [], entries: [] },
    kernel: { prepared: [] },
    kind: "eve-agent-info",
    mode: "development",
    remoteAgents: { entries: [], total: 0 },
    sandbox: { source: { logicalPath: "sandbox.ts", owner: "framework", sourceId: "sandbox.ts" } },
    schedules: [],
    skills: { dynamicResolvers: [], entries: [] },
    subagents: { local: [], total: 0 },
    tools: { dynamicResolvers: [], entries: [] },
    version: 3,
    workspace: { rootEntries: [] },
  };
}

describe("BOOT_DETECTIONS", () => {
  it("keeps an unavailable runtime diagnostic-only", async () => {
    const issues = await detectSetupIssues(context());
    expect(issues).toEqual([
      { kind: "attention", label: "model provider not linked", command: "/model" },
    ]);
  });

  it("diagnoses a disconnected gateway", async () => {
    const info = infoWithEndpoint({ kind: "gateway", connected: false });

    const issues = await detectSetupIssues(context({ info }));
    expect(issues).toEqual([
      {
        kind: "attention",
        label: "model provider not linked",
        command: "/model",
      },
    ]);
  });

  it.each([
    ["AI_GATEWAY_API_KEY", "key"],
    ["VERCEL_OIDC_TOKEN", "token"],
  ])(
    "treats a newly loaded gateway credential as configured while runtime info catches up",
    async (key, value) => {
      const info = infoWithEndpoint({ kind: "gateway", connected: false });

      await expect(detectSetupIssues(context({ env: { [key]: value }, info }))).resolves.toEqual(
        [],
      );
    },
  );

  it("upgrades a disconnected gateway endpoint when a local credential is loaded", () => {
    const info = infoWithEndpoint({ kind: "gateway", connected: false });

    expect(normalizeLocalModelEndpoint(info, { AI_GATEWAY_API_KEY: "key" })).toMatchObject({
      agent: {
        model: {
          endpoint: { kind: "gateway", connected: true, credential: "api-key" },
        },
      },
    });
  });

  it.each([
    ["AI_GATEWAY_API_KEY", "key"],
    ["VERCEL_OIDC_TOKEN", "token"],
  ])("does not infer AI Gateway routing from a local credential alone", async (key, value) => {
    const issues = await detectSetupIssues(context({ env: { [key]: value } }));

    expect(issues).toEqual([
      { kind: "attention", label: "model provider not linked", command: "/model" },
    ]);
  });

  it("stays quiet for an external-provider model — gateway linking/credentials don't apply", async () => {
    const info = infoWithEndpoint({ kind: "external", provider: "anthropic" });
    // No gateway env credentials and the unlinked appRoot would otherwise flag.
    expect(await detectSetupIssues(context({ info }))).toEqual([]);
  });

  it("stays quiet when the runtime resolved linked-project OIDC", async () => {
    const info = infoWithEndpoint({ kind: "gateway", connected: true, credential: "oidc" });

    expect(await detectSetupIssues(context({ info }))).toEqual([]);
  });

  it("skips a throwing detection instead of failing the boot", async () => {
    const info = infoWithEndpoint({ kind: "gateway", connected: false });
    const issues = await detectSetupIssues(context({ env: { AI_GATEWAY_API_KEY: "k" }, info }), [
      {
        id: "broken",
        detect: () => {
          throw new Error("boom");
        },
      },
      ...BOOT_DETECTIONS,
    ]);
    expect(issues).toEqual([]);
  });
});

describe("formatSetupIssuesLine", () => {
  it("mirrors the Claude Code attention-line shape", () => {
    expect(
      formatSetupIssuesLine([
        { kind: "attention", label: "AI Gateway credentials", command: "/model" },
      ]),
    ).toBe("1 setup issue: AI Gateway credentials · /model");
  });

  it("pluralizes and joins multiple issues", () => {
    expect(
      formatSetupIssuesLine([
        { kind: "attention", label: "AI Gateway credentials", command: "/model" },
        { kind: "attention", label: "Channels", command: "/channels" },
      ]),
    ).toBe("2 setup issues: AI Gateway credentials · /model, Channels · /channels");
  });

  it("formats the logged-out hint, which is not a boot detection", () => {
    // Confirming login is a `vercel whoami` subprocess, so the hint lives
    // outside the cheap-and-local BOOT_DETECTIONS and is rendered by the runner.
    expect(BOOT_DETECTIONS.some((detection) => detection.id === "login")).toBe(false);
    expect(formatSetupIssuesLine([LOGIN_SETUP_ISSUE])).toBe(
      "1 setup issue: not logged in · /vc:login",
    );
  });

  it("formats the CLI-missing hint, which points at its own fix command", () => {
    expect(formatSetupIssuesLine([CLI_MISSING_SETUP_ISSUE])).toBe(
      "1 setup issue: Vercel CLI not found · /vc:install",
    );
  });
});

describe("orderedSetupIssues", () => {
  it("puts the auth prerequisite before the boot detections", () => {
    const modelIssue = {
      kind: "attention" as const,
      label: "model provider not linked",
      command: "/model" as const,
    };
    expect(orderedSetupIssues([modelIssue], CLI_MISSING_SETUP_ISSUE)).toEqual([
      CLI_MISSING_SETUP_ISSUE,
      modelIssue,
    ]);
    expect(orderedSetupIssues([modelIssue], LOGIN_SETUP_ISSUE)).toEqual([
      LOGIN_SETUP_ISSUE,
      modelIssue,
    ]);
  });

  it("returns the boot issues unchanged when no auth prerequisite is unmet", () => {
    const boot = [
      { kind: "attention" as const, label: "AI Gateway credentials missing", command: "/model" },
    ];
    expect(orderedSetupIssues(boot, undefined)).toEqual(boot);
  });
});
