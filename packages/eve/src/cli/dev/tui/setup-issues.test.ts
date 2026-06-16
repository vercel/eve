import { describe, expect, it } from "vitest";

import {
  BOOT_DETECTIONS,
  CLI_MISSING_SETUP_ISSUE,
  detectSetupIssues,
  formatSetupIssuesLine,
  LOGIN_SETUP_ISSUE,
  type BootDetectionContext,
} from "./setup-issues.js";

function context(overrides: Partial<BootDetectionContext> = {}): BootDetectionContext {
  return { appRoot: "/nonexistent", env: {}, ...overrides };
}

type AgentInfo = NonNullable<BootDetectionContext["info"]>;

/** A minimal but fully-typed `/eve/v1/info` payload carrying a routing decision. */
function infoWithRouting(routing: AgentInfo["agent"]["model"]["routing"]): AgentInfo {
  return {
    agent: { agentRoot: "/a", appRoot: "/a", model: { id: "m", routing }, name: "Agent" },
    capabilities: { devRoutes: true },
    channels: { authored: [], available: [], disabledFramework: [], framework: [] },
    connections: [],
    diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
    hooks: [],
    instructions: { dynamic: [], static: null },
    kind: "eve-agent-info",
    mode: "development",
    sandbox: null,
    schedules: [],
    skills: { dynamic: [], static: [] },
    subagents: { local: [], total: 0 },
    tools: {
      authored: [],
      available: [],
      disabledFramework: [],
      dynamic: [],
      framework: [],
      reserved: [],
    },
    version: 1,
    workflow: { enabled: false, toolName: "Workflow" },
    workspace: { resourceRoot: null, rootEntries: [] },
  };
}

describe("BOOT_DETECTIONS", () => {
  it("diagnoses an unlinked directory as ONE issue — the missing link subsumes credentials", async () => {
    const issues = await detectSetupIssues(context());
    expect(issues).toEqual([{ label: "model provider not linked", command: "/model" }]);
  });

  it("stays quiet when either gateway credential is present, linked or not", async () => {
    expect(await detectSetupIssues(context({ env: { AI_GATEWAY_API_KEY: "key" } }))).toEqual([]);
    expect(await detectSetupIssues(context({ env: { VERCEL_OIDC_TOKEN: "token" } }))).toEqual([]);
  });

  it("stays quiet for an external-provider model — gateway linking/credentials don't apply", async () => {
    const info = infoWithRouting({ kind: "external", provider: "anthropic" });
    // No gateway env credentials and the unlinked appRoot would otherwise flag.
    expect(await detectSetupIssues(context({ info }))).toEqual([]);
  });

  it("skips a throwing detection instead of failing the boot", async () => {
    const issues = await detectSetupIssues(context({ env: { AI_GATEWAY_API_KEY: "k" } }), [
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
    expect(formatSetupIssuesLine([{ label: "AI Gateway credentials", command: "/model" }])).toBe(
      "1 setup issue: AI Gateway credentials · /model",
    );
  });

  it("pluralizes and joins multiple issues", () => {
    expect(
      formatSetupIssuesLine([
        { label: "AI Gateway credentials", command: "/model" },
        { label: "Channels", command: "/channels" },
      ]),
    ).toBe("2 setup issues: AI Gateway credentials · /model, Channels · /channels");
  });

  it("formats the logged-out hint, which is not a boot detection", () => {
    // Confirming login is a `vercel whoami` subprocess, so the hint lives
    // outside the cheap-and-local BOOT_DETECTIONS and is rendered by the runner.
    expect(BOOT_DETECTIONS.some((detection) => detection.id === "login")).toBe(false);
    expect(formatSetupIssuesLine([LOGIN_SETUP_ISSUE])).toBe(
      "1 setup issue: not logged in · /login",
    );
  });

  it("formats the CLI-missing hint, which points at its own fix command", () => {
    expect(formatSetupIssuesLine([CLI_MISSING_SETUP_ISSUE])).toBe(
      "1 setup issue: Vercel CLI not found · /vc",
    );
  });
});
