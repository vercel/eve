import { describe, expect, it } from "vitest";

interface BuildProfile {
  durationMs: number;
  kind: "eve-build-profile";
  phases: Array<{
    durationMs: number;
    name: string;
  }>;
  schemaVersion: 1;
  target: "local" | "vercel";
}

interface BuildProfileReport {
  baseline: null | {
    label: string;
    profile: BuildProfile;
  };
  comparison: null | {
    durationMs: {
      baseline: number;
      current: number;
      delta: number;
    };
    phases: Array<{
      baselineDurationMs: null | number;
      currentDurationMs: null | number;
      deltaMs: null | number;
      name: string;
    }>;
  };
  current: {
    label: string;
    profile: BuildProfile;
  };
  sandboxPrewarm: "included" | "skipped";
}

interface BuildProfileReportModule {
  createBuildProfileReport(input: {
    appLabel: string;
    baselineLabel?: string;
    baselineProfile?: BuildProfile | null;
    currentLabel?: string;
    currentProfile: BuildProfile;
    requiredCurrentPhases?: string[];
    sandboxPrewarm?: "included" | "skipped";
  }): BuildProfileReport;
  renderBuildProfileReportMarkdown(report: BuildProfileReport): string;
  renderBuildProfileTimingLog(report: BuildProfileReport): string;
}

async function loadBuildProfileReportModule(): Promise<BuildProfileReportModule> {
  const moduleUrl = new URL("../../../scripts/build-profile-report.mjs", import.meta.url);

  return (await import(moduleUrl.href)) as BuildProfileReportModule;
}

function createProfile(input: {
  durationMs: number;
  phases: BuildProfile["phases"];
}): BuildProfile {
  return {
    durationMs: input.durationMs,
    kind: "eve-build-profile",
    phases: input.phases,
    schemaVersion: 1,
    target: "vercel",
  };
}

describe("build profile report", () => {
  it("renders a phase-by-phase comparison against a baseline profile", async () => {
    const { createBuildProfileReport, renderBuildProfileReportMarkdown } =
      await loadBuildProfileReportModule();
    const report = createBuildProfileReport({
      appLabel: "apps/fixtures/weather-agent",
      baselineLabel: "main (abc1234)",
      baselineProfile: createProfile({
        durationMs: 1_000,
        phases: [
          { durationMs: 600, name: "nitro.app.bundle" },
          { durationMs: 200, name: "workflow.emit" },
        ],
      }),
      currentProfile: createProfile({
        durationMs: 1_250,
        phases: [
          { durationMs: 700, name: "nitro.app.bundle" },
          { durationMs: 300, name: "workflow.emit" },
          { durationMs: 40, name: "output.publish" },
        ],
      }),
      sandboxPrewarm: "skipped",
    });
    const markdown = renderBuildProfileReportMarkdown(report);

    expect(report.comparison?.durationMs).toEqual({
      baseline: 1_000,
      current: 1_250,
      delta: 250,
    });
    expect(report.comparison?.phases).toEqual([
      {
        baselineDurationMs: 600,
        currentDurationMs: 700,
        deltaMs: 100,
        name: "nitro.app.bundle",
      },
      {
        baselineDurationMs: 200,
        currentDurationMs: 300,
        deltaMs: 100,
        name: "workflow.emit",
      },
      {
        baselineDurationMs: null,
        currentDurationMs: 40,
        deltaMs: null,
        name: "output.publish",
      },
    ]);
    expect(markdown).toContain("## Build Timing: `apps/fixtures/weather-agent`");
    expect(markdown).toContain("sandbox template prewarm skipped");
    expect(markdown).toContain(
      "Build pipeline: 1.00 s -> **1.25 s** (+250.0 ms) vs `main (abc1234)`.",
    );
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>Detailed phase timings vs `main (abc1234)`</summary>");
    expect(markdown).toContain("| `nitro.app.bundle` | 600.0 ms | 700.0 ms | +100.0 ms |");
    expect(markdown).toContain("| `output.publish` | — | 40.0 ms | — |");
  });

  it("renders the current profile without a baseline", async () => {
    const { createBuildProfileReport, renderBuildProfileReportMarkdown } =
      await loadBuildProfileReportModule();
    const report = createBuildProfileReport({
      appLabel: "apps/fixtures/weather-agent",
      currentProfile: createProfile({
        durationMs: 500,
        phases: [{ durationMs: 450, name: "nitro.flow.bundle" }],
      }),
    });
    const markdown = renderBuildProfileReportMarkdown(report);

    expect(report.baseline).toBeNull();
    expect(report.comparison).toBeNull();
    expect(markdown).toContain("Current build pipeline: **500.0 ms** (target: `vercel`).");
    expect(markdown).toContain("deployable Vercel build with sandbox template prewarm included");
    expect(markdown).toContain("No baseline build profile was supplied");
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>Detailed phase timings</summary>");
    expect(markdown).toContain("| `nitro.flow.bundle` | 450.0 ms |");
  });

  it("requires prewarm when a deployable-build regression check requests it", async () => {
    const { createBuildProfileReport } = await loadBuildProfileReportModule();

    expect(() =>
      createBuildProfileReport({
        appLabel: "apps/fixtures/weather-agent",
        currentProfile: createProfile({
          durationMs: 500,
          phases: [{ durationMs: 450, name: "nitro.flow.bundle" }],
        }),
        requiredCurrentPhases: ["sandbox.prewarm"],
      }),
    ).toThrow('Current build profile is missing required phase "sandbox.prewarm".');
  });

  it("renders only the build time for E2E logs without copying unrecognized profile fields", async () => {
    const { createBuildProfileReport, renderBuildProfileTimingLog } =
      await loadBuildProfileReportModule();
    const profile = {
      ...createProfile({
        durationMs: 500,
        phases: [{ durationMs: 450, name: "nitro.flow.bundle" }],
      }),
      VERCEL_OIDC_TOKEN: "must-not-appear-in-summary",
    };
    const report = createBuildProfileReport({
      appLabel: "e2e/fixtures/agent-tools-sandbox",
      currentProfile: profile,
    });
    const output = renderBuildProfileTimingLog(report);

    expect(output).toBe(
      "eve build (e2e/fixtures/agent-tools-sandbox): 500.0 ms (sandbox template prewarm included).",
    );
    expect(output).not.toContain("must-not-appear-in-summary");
    expect(JSON.stringify(report)).not.toContain("must-not-appear-in-summary");
  });
});
